// Ad-hoc named-volume toolbox. The restic pair lives in backup.ts (it needs the
// vault's secret channel); cli.ts registers them all as subcommands.
import { $ } from "bun";
import { fleetImage, sshTarget } from "./inv";
import { execSpec, shQuote } from "./remote";

const guard = (vol: string) =>
  `docker volume inspect '${vol}' >/dev/null 2>&1 || ` +
  `{ echo 'fleet: no such volume: ${vol}' >&2; exit 1; }\n`;

async function run(host: string, script: string): Promise<never> {
  const r = await $`${execSpec(host, script)}`.nothrow();
  process.exit(r.exitCode ?? 1);
}

// Volume-root-relative.
const rel = (p: string) => p.replace(/^\/+/, "");

// Server disks are never mounted; `--` keeps a leading flag in cmd for the
// helper, not for us.
export function volumeRun(vol: string, host: string, cmd: string[]): Promise<never> {
  sshTarget(host); // fail early on unknown server
  return run(host, `${guard(vol)}docker run --rm -i -v '${vol}:/v' alpine ${cmd.join(" ")}`);
}

// Bytes travel via stdio, so `> file` at the call site streams through,
// binary-safe.
export function volumeDownload(vol: string, host: string, path: string): Promise<never> {
  sshTarget(host);
  return run(
    host,
    `${guard(vol)}docker run --rm -v '${vol}:/v:ro' alpine cat ${shQuote(`/v/${rel(path)}`)}`,
  );
}

// Creates the volume when absent (restores land on fresh boxes), and mkdir -p
// the parent so nested paths just work.
export function volumeUpload(vol: string, host: string, path: string): Promise<never> {
  sshTarget(host);
  const p = rel(path);
  return run(
    host,
    `docker volume create '${vol}' > /dev/null\n` +
      `docker run --rm -i -v '${vol}:/v' alpine sh -c ` +
      `'d=$(dirname "/v/${p}"); [ "$d" = /v ] || mkdir -p "$d"; cat > "/v/${p}"'`,
  );
}

// Mount writable so sqlite can coordinate the WAL's -shm.
export function volumeSqliteDump(vol: string, host: string, path: string): Promise<never> {
  sshTarget(host);
  return run(
    host,
    `${guard(vol)}docker run --rm -v '${vol}:/v' --entrypoint sh ${fleetImage("SQLITE_IMAGE")} -c ` +
      `'sqlite3 "/v/${rel(path)}" ".backup /snap.db" && cat /snap.db'`,
  );
}
