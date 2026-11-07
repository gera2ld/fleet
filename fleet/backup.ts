// The restic pair of the volume toolbox, driven by a volume's manifest `backup:`
// list: `sqlite` entries are staged with `.backup`, `file` entries read as they
// are, and both land in ONE snapshot. Every container runs on the host holding
// the volume, so the data never lands on the center.
import { $ } from "bun";
import {
  type DumpEntry,
  CLI,
  ENV_DIR,
  InventoryError,
  ROOT,
  SECRET_PLUGIN,
  backupEntries,
  dumpEntries,
  fleetImage,
  hasBackup,
  hostsFor,
  service,
  serviceNames,
  sshTarget,
} from "./inv";
import { loadEnv } from "../shared/load-env";
import { containerLookup, execSpec, shQuote } from "./remote";
import { readSecret } from "./prepare";

// SCRATCH stages one snapshot and is removed after every run. CACHE persists:
// it holds the repository index, which would otherwise be re-fetched per run.
const SCRATCH = "fleet-restic-scratch";
const CACHE = "fleet-restic-cache";
// Staging root for sqlite snapshots: a sibling of the volume root, not inside
// it — the live volume is mounted read-only and docker would have to create a
// mountpoint in there. Hence a declared path may not start with `.fleet/`.
const STAGE = "/.fleet";

// Restic credentials live in a single encrypted env file; the vault holds only
// the FLEET_ENCRYPTION_KEY that unlocks it.
const BACKUP_ENV = process.env.FLEET_BACKUP_ENV ?? "fleet-backup.env.enc";
async function secretFile(): Promise<Record<string, string>> {
  const key = await vault("FLEET_ENCRYPTION_KEY");
  if (!key) {
    throw new InventoryError("backup: FLEET_ENCRYPTION_KEY is not readable from the vault");
  }
  return loadEnv([BACKUP_ENV], { key, dir: ENV_DIR });
}

// quiet() is load-bearing: `$` tees to the terminal as well as capturing, so
// without it every value read here would print.
async function vault(name: string): Promise<string | undefined> {
  const r = await $`${SECRET_PLUGIN} ${name}`.quiet().nothrow();
  const val = r.exitCode === 0 ? r.stdout.toString() : "";
  return val === "" ? undefined : val;
}

// Values go verbatim into a `NAME=value` file on the script's stdin, which docker
// reads as --env-file /dev/stdin: no shell sees them and they never reach argv,
// ps or disk. Single-line only — an env file is lines.
async function resticEnv(): Promise<string> {
  const file = await secretFile();
  for (const name of ["RESTIC_REPOSITORY", "RESTIC_PASSWORD"]) {
    if (!file[name]) {
      throw new InventoryError(`backup: '${name}' is not set in ${BACKUP_ENV}`);
    }
  }
  const ak = file.AWS_ACCESS_KEY_ID;
  const sk = file.AWS_SECRET_ACCESS_KEY;
  if ((ak && !sk) || (!ak && sk)) {
    throw new InventoryError(
      `backup: set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in ${BACKUP_ENV}, or neither`,
    );
  }
  return (
    Object.entries(file)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n") + "\n"
  );
}

// The owning service names both the tag and the in-snapshot path, so `restic
// ls` reads /vaultwarden/db.sqlite3 with no lookup.
function owner(vol: string): string {
  for (const svc of serviceNames()) {
    if (vol in service(svc).volumes) return svc;
  }
  return vol;
}

// stdin stays unread for the restic container's env file, and steps are
// &&-chained so a failed snapshot can never be reported as a successful upload.
function prologue(vol: string, gate = ""): string {
  return (
    `docker volume inspect ${shQuote(vol)} >/dev/null 2>&1 || ` +
    `{ echo ${shQuote(`fleet: no such volume: ${vol}`)} >&2; exit 1; }\n` +
    gate +
    `W=${shQuote(SCRATCH)}\n` +
    `docker volume rm -f "$W" >/dev/null 2>&1 || true\n` +
    `docker volume create "$W" >/dev/null &&\n`
  );
}

function epilogue(): string {
  return `rc=$?\n` + `docker volume rm -f "$W" >/dev/null 2>&1 || true\n` + `exit $rc\n`;
}

// The one direct spawn: `$` cannot write to stdin, and the env file must not
// touch disk. stdio stays inherited so restic's progress and errors show.
async function runScript(cmd: string[], envFile: string): Promise<number> {
  if (process.env.FLEET_DEBUG_BACKUP) console.error(`backup: ${cmd.join(" ")}`);
  const proc = Bun.spawn({
    cmd,
    stdin: new Blob([envFile]),
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function runCmd(cmd: string[], envFile: string): Promise<never> {
  process.exit(await runScript(cmd, envFile));
}

// Online snapshot into the scratch volume, mounted at `mount`; `at` must sit
// under it or the file lands at the volume root, one level off. Read-write so
// sqlite can coordinate the WAL's -shm. The source must exist — sqlite3 would
// otherwise create an empty db and report a successful snapshot of nothing.
function snapshotStep(vol: string, mount: string, at: string, p: string): string {
  const payload =
    `[ -f ${shQuote(`/v/${p}`)} ] || { echo ${shQuote(`fleet: '${vol}' has no ${p}`)} >&2; exit 1; }; ` +
    `d=$(dirname ${shQuote(at)}); mkdir -p "$d"; ` +
    `sqlite3 ${shQuote(`/v/${p}`)} ${shQuote(`.backup ${at}`)} && ` +
    `chmod 0644 ${shQuote(at)}`;
  return (
    `docker run --rm -v ${shQuote(`${vol}:/v`)} -v "$W":${shQuote(mount)} ` +
    `--entrypoint sh ${fleetImage("SQLITE_IMAGE")} -c ${shQuote(payload)}`
  );
}

// --hostname, or restic records a container id and `restore latest --host <box>`
// cannot pick the right snapshot.
function resticStep(host: string, mounts: string[], args: string): string {
  return (
    `docker run --rm --hostname ${shQuote(host)} ${mounts.join(" ")} ` +
    `-v ${shQuote(`${CACHE}:/cache`)} --env-file /dev/stdin ${fleetImage("RESTIC_IMAGE")} ${args}`
  );
}

const scratch = (dst: string) => `-v "$W":${shQuote(dst)}`;

// One snapshot per volume, holding the whole declared set: `sqlite` entries
// staged under /.fleet, `file` entries read off the live volume (mounted
// read-only). No narrower mode — a partial snapshot would be the newest match
// for the next restore.
export async function resticBackup(vol: string, host: string) {
  sshTarget(host); // fail early on unknown server
  const svc = owner(vol);
  const entries = backupEntries(svc, vol);
  if (entries.length === 0) {
    throw new InventoryError(
      `backup: '${vol}' declares no backup entries — add them to ${svc}/service.yaml`,
    );
  }
  const envFile = await resticEnv();
  const staged = entries.filter((e) => e.kind === "sqlite");
  const live = entries.filter((e) => e.kind === "file");
  // No host tag: restic records the box itself from --hostname, which is what
  // `restore latest --host <box>` selects on.
  const tagFlags = ["fleet", `svc=${svc}`, `vol=${vol}`]
    .map((t) => `--tag ${shQuote(t)}`)
    .join(" ");
  const paths_ = [
    ...staged.map((e) => `${STAGE}/${e.path}`),
    ...live.map((e) => `/${svc}/${e.path}`),
  ]
    .map(shQuote)
    .join(" ");
  const script =
    prologue(vol) +
    [
      ...staged.map((e) => snapshotStep(vol, STAGE, `${STAGE}/${e.path}`, e.path)),
      resticStep(
        host,
        [scratch(`${STAGE}:ro`), `-v ${shQuote(`${vol}:/${svc}:ro`)}`],
        `backup ${tagFlags} ${paths_}`,
      ),
    ].join(" &&\n") +
    "\n" +
    epilogue();
  await runCmd(execSpec(host, script), envFile);
}

// Nothing may still mount the volume (a raw write under a live service corrupts
// the db), and a restored db's -wal/-shm go, or sqlite replays a stale WAL.
export async function resticRestore(vol: string, host: string, snap: string) {
  sshTarget(host);
  const svc = owner(vol);
  const entries = backupEntries(svc, vol);
  if (entries.length === 0) {
    throw new InventoryError(
      `restore: '${vol}' declares no backup entries — add them to ${svc}/service.yaml`,
    );
  }
  const envFile = await resticEnv();
  const at = `/${svc}`;
  const gate =
    `c=$(docker ps -q --filter ${shQuote(`volume=${vol}`)})\n` +
    `if [ -n "$c" ]; then\n` +
    `  echo ${shQuote(`fleet: volume '${vol}' is in use — stop the service first (${CLI} down ${svc} ${host}):`)} >&2\n` +
    `  echo "  $c" >&2\n` +
    `  exit 1\n` +
    `fi\n`;
  // The box a snapshot came from is irrelevant: the default is the volume's
  // latest snapshot from any host, so a migration restores onto a box that
  // never backed up. The <host> arg only selects the box to restore onto
  // (and whose credentials to use).
  // Only filter by volume when a service backs up more than one, or snapshots
  // taken before the tag existed stop matching.
  const volTag =
    Object.keys(service(svc).volumes).filter((v) => hasBackup(svc, v)).length > 1
      ? ` --tag ${shQuote(`vol=${vol}`)}`
      : "";
  const sel = snap ? shQuote(snap) : `latest --path ${shQuote(at)}${volTag}`;
  // `cat >` truncates in place, so the inode keeps the owner and mode the app had;
  // onto an empty volume everything lands root-owned (the README says how to
  // fix). A directory entry is copied recursively.
  const put = (src: string, p: string) => {
    const dst = `/v/${p}`;
    const keep =
      `chown "$(stat -c %u ${shQuote(dst)}):$(stat -c %g ${shQuote(dst)})" ${shQuote(dst)} 2>/dev/null || true; ` +
      `chmod "$(stat -c %a ${shQuote(dst)})" ${shQuote(dst)} 2>/dev/null || true`;
    return [
      `[ -e ${shQuote(src)} ] || { echo ${shQuote(`fleet: snapshot holds no ${src}`)} >&2; exit 1; }`,
      `mkdir -p $(dirname ${shQuote(dst)})`,
      `if [ -d ${shQuote(src)} ]; then mkdir -p ${shQuote(dst)}; cp -a ${shQuote(`${src}/.`)} ${shQuote(`${dst}/`)}; ${keep};` +
        `else cat ${shQuote(src)} > ${shQuote(dst)}; ${keep}; fi`,
      `rm -f ${shQuote(`${dst}-wal`)} ${shQuote(`${dst}-shm`)}`,
    ].join("; ");
  };
  const payload = [
    "set -e",
    ...entries.map((e) =>
      e.kind === "sqlite"
        ? put(`/out${STAGE}/${e.path}`, e.path)
        : put(`/out/${svc}/${e.path}`, e.path),
    ),
  ].join("; ");
  const script =
    prologue(vol, gate) +
    [
      resticStep(host, [scratch("/out")], `restore ${sel} --target /out`),
      `docker run --rm -v ${shQuote(`${vol}:/v`)} -v "$W":/out:ro alpine sh -c ${shQuote(payload)}`,
    ].join(" &&\n") +
    "\n" +
    epilogue();
  await runCmd(execSpec(host, script), envFile);
}

// One dump per snapshot, produced inside the service's own container (its local
// socket and credentials are already there) and bind-mounted straight into the
// restic container at its final path — no staging volume, since a dump is
// written fresh rather than copied off a live one. The dump lands in a host
// tmpfile for the length of the command, which the script removes; the `&&`
// means restic never runs unless the dump itself succeeded, so a truncated dump
// cannot become a snapshot.
function dumpStep(svc: string, d: DumpEntry, host: string): string {
  const at = `/${svc}/dumps/${d.name}.sql`;
  return (
    containerLookup(svc, d.service ?? "") +
    `\nT=$(mktemp)\n` +
    `docker exec "$c" ${d.cmd.map((a) => shQuote(a)).join(" ")} > "$T" && ` +
    `docker run --rm --hostname ${shQuote(host)} -v "$T":${shQuote(`${at}:ro`)} ` +
    `-v ${shQuote(`${CACHE}:/cache`)} --env-file /dev/stdin ${fleetImage("RESTIC_IMAGE")} ` +
    `backup --tag fleet --tag ${shQuote(`svc=${svc}`)} ` +
    `--tag ${shQuote(`dump=${d.name}`)} ${shQuote(at)}\n` +
    `rc=$?\nrm -f "$T"\nexit $rc\n`
  );
}

// dump-backup <service> [hosts]
export async function dumpBackup(svc: string, hosts: string[]) {
  const dumps = dumpEntries(svc);
  if (dumps.length === 0) {
    throw new InventoryError(
      `backup: ${svc} declares no dumps — add them under backup: in ${svc}/service.yaml`,
    );
  }
  const names = hostsFor(svc, hosts);
  if (names.length === 0) throw new InventoryError("no hosts selected");
  let bad = 0;
  for (const host of names) {
    sshTarget(host);
    const envFile = await resticEnv();
    const script = execSpec(host, dumps.map((d) => dumpStep(svc, d, host)).join("\n"));
    if ((await runScript(script, envFile)) !== 0) bad = 1;
  }
  if (bad) process.exit(1);
}

export async function envTool(argv: string[]) {
  let fileCount = 0;
  while (argv[fileCount]?.endsWith(".env.enc")) fileCount++;
  const files = argv.slice(0, fileCount);
  const command = argv.slice(fileCount).filter((arg, index) => !(index === 0 && arg === "--"));
  if (files.length === 0 || command.length === 0) {
    throw new InventoryError("usage: fleet env <file.env.enc>... -- <command> [args...]");
  }
  const key = await readSecret("FLEET_ENCRYPTION_KEY");
  const env = await loadEnv(files, { key, dir: ROOT });
  const result = await $`${command}`.env({ ...process.env, ...env }).nothrow();
  process.exit(result.exitCode ?? 1);
}
