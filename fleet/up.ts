// Service lifecycle on the servers: up / restart / push-volumes / down /
// setup-volumes / one-off container exec.
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLI, ROOT, TMP_DIR, InventoryError, service, sshTarget, volumeFiles } from "./inv";
import { containerLookup, execSpec, composeRemote, shQuote } from "./remote";
import { render } from "./render";

// Best-effort pull, then stream the rendered compose via stdin and `up -d`
// (falls back to local images when the registry hiccups). Never touches volume
// data, so remote edits survive; push-volumes writes config explicitly.
// forceRecreate is what you want after pushing volume content, since compose
// would otherwise see an unchanged config and leave the container alone.
export async function up(svc: string, hosts: string[], opts: { forceRecreate?: boolean } = {}) {
  const names = await render(svc, hosts);
  const vols = Object.keys(service(svc).volumes);
  const verb = opts.forceRecreate ? "up -d --force-recreate" : "up -d";
  let bad = 0;
  for (const name of names) {
    const target = sshTarget(name);
    console.log(`=== ${name} (${target}) ===`);
    let ok = true;
    for (const vol of vols) {
      // Absent volume = setup-volumes never ran; going up would start an empty config.
      const check = `docker volume inspect '${vol}' > /dev/null 2>&1`;
      const r = await $`${execSpec(name, check)}`.nothrow();
      if (r.exitCode !== 0) {
        console.error(
          `FAIL: ${name}: volume '${vol}' not found — run '${CLI} setup-volumes ${svc} ${name}' first`,
        );
        ok = false;
      }
    }
    if (!ok) {
      bad = 1;
      continue;
    }
    const compose = join(TMP_DIR, name, svc, "compose.yml");
    const pull = await $`${execSpec(name, composeRemote(svc, "pull"))} < ${compose}`.nothrow();
    if (pull.exitCode !== 0)
      console.error(`warn: ${name}: pull failed — up falls back to local images`);
    const up = await $`${execSpec(name, composeRemote(svc, verb))} < ${compose}`.nothrow();
    if (up.exitCode === 0) console.log(`ok: ${name}`);
    else {
      console.error(`FAIL: ${name}`);
      bad = 1;
    }
  }
  if (bad) process.exit(1);
}

// The volume root plus every directory the tar must create. Non-recursive on
// purpose: a pre-existing file elsewhere in the volume must not be touched.
function dirsForTargets(targets: string[]): string[] {
  const dirs = new Set<string>(["/t"]);
  for (const t of targets) {
    const parts = t.split("/").filter(Boolean);
    parts.pop();
    for (let i = 1; i <= parts.length; i++) dirs.add(`/t/${parts.slice(0, i).join("/")}`);
  }
  return [...dirs];
}

// The permission pass that runs after extraction. Fleet-owned config is 444,
// deliberately unwriteable. A `writable` volume belongs to the app, so its files
// and the directories holding them are made writable instead — by mode, not by
// chown, because the fleet does not know which uid the image runs as.
function permsStep(svc: string, vol: string, targets: string[]): string {
  if (targets.length === 0) return "";
  const helper = `docker run --rm -v '${vol}:/t' alpine`;
  const paths = targets.map((t) => shQuote(`/t/${t}`)).join(" ");
  if (service(svc).volumes[vol]?.writable !== true) return ` && ${helper} chmod 444 ${paths}`;
  const dirs = dirsForTargets(targets).map(shQuote).join(" ");
  return ` && ${helper} chmod 666 ${paths} && ${helper} chmod 777 ${dirs}`;
}

// One tar-stream per volume, over stdin (server disks are never mounted). The
// remote shell creates the volume, extracts into it, then fixes permissions on
// exactly the pushed paths. Extraction is additive — tar only overwrites
// archived members, so remote-only files (a runtime-generated sites file) stay.
async function pushVolume(svc: string, vol: string, targets: string[], name: string) {
  const stagedir = join(TMP_DIR, name, svc, vol);
  for (const t of targets) {
    if (!existsSync(join(stagedir, t)))
      throw new InventoryError(`file not found: ${stagedir}/${t}`);
  }
  const script =
    `docker volume create '${vol}' > /dev/null` +
    ` && docker run --rm -i -v '${vol}:/t' alpine tar -xf - -C /t` +
    permsStep(svc, vol, targets);
  // COPYFILE_DISABLE keeps macOS tar from injecting ._* AppleDouble files.
  await $`COPYFILE_DISABLE=1 tar -cf - -C ${stagedir} . | ${execSpec(name, script)}`;
  console.log(`pushed ${targets.length} file(s) to volume '${vol}' on ${name}`);
}

// Missing or empty? `setup-volumes` seeds only those — re-running it on a
// live box never touches seeded data.
async function volumeState(name: string, vol: string): Promise<"missing" | "empty" | "seeded"> {
  const script =
    `if ! docker volume inspect '${vol}' >/dev/null 2>&1; then echo missing\n` +
    `elif [ -z "$(docker run --rm -v '${vol}:/v' alpine ls -A /v 2>/dev/null)" ]; then echo empty\n` +
    `else echo seeded\nfi`;
  const out = await $`${execSpec(name, script)}`.text();
  const state = out.trim().split("\n").pop()?.trim();
  if (state === "missing" || state === "empty" || state === "seeded") return state;
  throw new InventoryError(`${name}: volume '${vol}': unexpected state: '${state ?? ""}'`);
}

// The rollout path for repo config changes after first boot: containers are left
// alone, so follow with whatever applies the new config.
export async function pushVolumes(svc: string, hosts: string[]) {
  const files = volumeFiles(svc);
  if (files.length === 0)
    throw new InventoryError(`${svc} declares no volume files — nothing to push`);
  const names = await render(svc, hosts);
  // One tar-stream per volume (not per file): group targets preserving order.
  const byVol = new Map<string, string[]>();
  for (const f of files) {
    const list = byVol.get(f.vol);
    if (list) list.push(f.target);
    else byVol.set(f.vol, [f.target]);
  }
  let bad = 0;
  for (const name of names) {
    const target = sshTarget(name);
    console.log(`=== ${name} (${target}) ===`);
    let ok = true;
    for (const [vol, targets] of byVol) {
      try {
        await pushVolume(svc, vol, targets, name);
      } catch (e) {
        console.error(`FAIL: ${name}: volume '${vol}': ${e instanceof Error ? e.message : e}`);
        ok = false;
      }
    }
    if (ok) console.log(`ok: ${name}`);
    else {
      console.error(`FAIL: ${name}`);
      bad = 1;
    }
  }
  if (bad) process.exit(1);
}

// Bounce the running containers in place (no re-pull, no recreate —
// `up --force-recreate` is the path when the config or image changed).
// Renders first so a broken template fails before anything is touched.
export async function restart(svc: string, hosts: string[]) {
  const names = await render(svc, hosts);
  let bad = 0;
  for (const name of names) {
    const target = sshTarget(name);
    console.log(`=== ${name} (${target}) ===`);
    const compose = join(TMP_DIR, name, svc, "compose.yml");
    const r = await $`${execSpec(name, composeRemote(svc, "restart"))} < ${compose}`.nothrow();
    if (r.exitCode === 0) console.log(`ok: ${name}`);
    else {
      console.error(`FAIL: ${name}`);
      bad = 1;
    }
  }
  if (bad) process.exit(1);
}

// Stop and remove the deployment (networks and volumes stay).
export async function down(svc: string, hosts: string[]) {
  const names = await render(svc, hosts, { teardown: true });
  let bad = 0;
  for (const name of names) {
    const target = sshTarget(name);
    console.log(`=== ${name} (${target}) ===`);
    const compose = join(TMP_DIR, name, svc, "compose.yml");
    const r = await $`${execSpec(name, composeRemote(svc, "down"))} < ${compose}`.nothrow();
    if (r.exitCode === 0) console.log(`ok: ${name}`);
    else {
      console.error(`FAIL: ${name}`);
      bad = 1;
    }
  }
  if (bad) process.exit(1);
}

// Creates missing volumes and seeds missing/empty ones with their declared
// files; a volume that already holds data is left alone, so this is safe to
// re-run. First boot is therefore `setup-volumes` + `up`.
export async function setupVolumes(svc: string, hosts: string[]) {
  const vols = Object.keys(service(svc).volumes);
  if (vols.length === 0) throw new InventoryError(`${svc} declares no volumes`);
  const names = await render(svc, hosts);
  const byVol = new Map<string, string[]>();
  for (const f of volumeFiles(svc)) {
    const list = byVol.get(f.vol);
    if (list) list.push(f.target);
    else byVol.set(f.vol, [f.target]);
  }
  let bad = 0;
  for (const name of names) {
    console.log(`=== ${name} (${sshTarget(name)}) ===`);
    let ok = true;
    for (const vol of vols) {
      try {
        const state = await volumeState(name, vol);
        if (state === "seeded") {
          console.log(`skip: volume '${vol}' on ${name} already has data`);
          continue;
        }
        const targets = byVol.get(vol) ?? [];
        if (targets.length === 0) {
          await $`${execSpec(name, `docker volume create '${vol}' > /dev/null`)}`;
          console.log(`created volume '${vol}' on ${name} (no files declared)`);
        } else {
          await pushVolume(svc, vol, targets, name);
        }
      } catch (e) {
        console.error(`FAIL: ${name}: volume '${vol}': ${e instanceof Error ? e.message : e}`);
        ok = false;
      }
    }
    if (ok) console.log(`ok: ${name}`);
    else {
      console.error(`FAIL: ${name}`);
      bad = 1;
    }
  }
  if (bad) process.exit(1);
}

// Resolved by compose LABELS, so no compose file is needed and stdin stays free
// for the caller's pipes; stdio is inherited, hence `< dump.sql` / `> dump.sql`
// at the call site stream straight through. Cmd args are re-quoted individually
// for the remote shell, so spaces and metacharacters arrive verbatim (docker
// exec runs no shell).
export async function exec(svc: string, key: string, host: string, args: string[]) {
  service(svc); // unknown service fails like everywhere else
  sshTarget(host); // fail early on unknown server
  const r = await $`${execSpec(
    host,
    `${containerLookup(svc, key)}\ndocker exec -i "$c" ${args.map((a) => shQuote(a)).join(" ")}`,
  )}`.nothrow();
  process.exit(r.exitCode ?? 1);
}
