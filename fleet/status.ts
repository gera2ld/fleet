// Fleet-wide deployment status: manifest services against their declared scope,
// then unmanaged projects, then per-host disk usage and pending reboots. A
// running container whose registry tag has moved gets `NEW`.
import { $ } from "bun";
import { join } from "node:path";
import { TMP_DIR, allHosts, serviceNames, hostsFor } from "./inv";
import { execSpec } from "./remote";

// Cells: up / partial / stopped (health suffix), absent (in scope but missing),
// off-scope (deployed outside the declared scope), `?` (host unreachable), `.`
// (out of scope, not there).
type Box = {
  project: string;
  state: string;
  healthy: boolean;
  img: string; // id of the image the container is actually running
  ref: string; // image ref the container was created with
  outdated: boolean;
};

type Disk = { mount: string; pct: string; used: number; avail: number }; // 1K blocks

// A cell that contradicts the manifest gets WARN; `.` is correctly absent.
const WARN = "WARN";

// Bun.color returns "" when stdout can't do ANSI, so paint degrades to plain.
const paint = (css: string, s: string) => {
  const open = Bun.color(css, "ansi") ?? "";
  return open ? `${open}${s}\x1b[0m` : s;
};

function statusCell(boxes: Box[], inScope: boolean): string {
  if (boxes.length === 0) return inScope ? `${paint("red", WARN)} absent` : ".";
  const up = boxes.filter((b) => b.state === "running");
  const state = up.length === 0 ? "stopped" : up.length < boxes.length ? "partial" : "up";
  const flags: string[] = [];
  if (state === "up" && up.every((b) => b.healthy)) flags.push(paint("green", "healthy"));
  if (up.some((b) => b.outdated)) flags.push(paint("yellow", "NEW"));
  if (!inScope) flags.push("off-scope");
  const cell = flags.length ? `${state} ${flags.join(" ")}` : state;
  return inScope && state === "up" ? cell : `${paint("red", WARN)} ${cell}`;
}

// "62% (30GB/48GB)" — used/total, red at >=90% full, yellow at >=80%.
function diskCell(d: Disk): string {
  const fmt = (blocks: number) => {
    const gb = blocks / 1024 / 1024;
    if (gb >= 10) return `${gb.toFixed(0)}GB`;
    if (gb >= 1) return `${gb.toFixed(1)}GB`;
    return `${(blocks / 1024).toFixed(0)}MB`;
  };
  const cell = `${d.pct} (${fmt(d.used)}/${fmt(d.used + d.avail)})`;
  const n = parseInt(d.pct, 10);
  if (Number.isFinite(n) && n >= 90) return paint("red", cell);
  if (Number.isFinite(n) && n >= 80) return paint("yellow", cell);
  return cell;
}

// Plain HTTPS with anonymous tokens, deliberately not the docker CLI, which
// resolves credentials through the keychain. A private registry rejects the
// anonymous token and comes back null, i.e. skipped.
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export function parseRef(ref: string): { host: string; repo: string; tag: string } | null {
  if (ref.includes("@")) return null; // digest-pinned: always current by definition
  const i = ref.lastIndexOf(":");
  const hasTag = i !== -1 && !ref.slice(i + 1).includes("/");
  const path = hasTag ? ref.slice(0, i) : ref;
  const tag = hasTag ? ref.slice(i + 1) : "latest";
  const slash = path.indexOf("/");
  const first = path.slice(0, slash === -1 ? path.length : slash);
  const named =
    slash !== -1 && (first.includes(".") || first.includes(":") || first === "localhost");
  const host = named ? first : "registry-1.docker.io";
  let repo = named ? path.slice(slash + 1) : path;
  if (!named && !repo.includes("/")) repo = `library/${repo}`;
  if (tag.includes("<none>")) return null;
  return { host, repo, tag };
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  return r && r.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null;
}

// Per-host, so refs sharing a registry fetch the challenge once. null =
// anonymous OK, or unreachable (the manifest call then decides).
const challenges = new Map<string, Promise<{ realm: string; service: string } | null>>();
function challenge(host: string) {
  const hit = challenges.get(host);
  if (hit) return hit;
  const p = (async () => {
    const r = await fetch(`https://${host}/v2/`, { signal: AbortSignal.timeout(8000) }).catch(
      () => null,
    );
    if (!r || r.ok) return null;
    const www = r.headers.get("www-authenticate") ?? "";
    const realm = /realm="([^"]+)"/.exec(www)?.[1];
    return realm ? { realm, service: /service="([^"]*)"/.exec(www)?.[1] ?? "" } : null;
  })();
  challenges.set(host, p);
  return p;
}

// Every digest a host could legitimately have pulled under `ref`: the sha256 of
// the raw body (the digest itself for a single manifest, the index digest for a
// list) plus each per-platform manifest of a multiarch index. null =
// unreachable, never reported as outdated.
export async function registryDigests(ref: string): Promise<Set<string> | null> {
  const p = parseRef(ref);
  if (!p) return null;
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  const ch = await challenge(p.host);
  if (ch) {
    const url = `${ch.realm}?service=${encodeURIComponent(ch.service)}&scope=${encodeURIComponent(`repository:${p.repo}:pull`)}`;
    const tok = await fetchJson(url);
    const token = (tok?.["token"] ?? tok?.["access_token"]) as string | undefined;
    if (!token) return null;
    headers["Authorization"] = `Bearer ${token}`;
  }
  const man = await fetch(`https://${p.host}/v2/${p.repo}/manifests/${p.tag}`, {
    headers,
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!man?.ok) return null;
  const raw = await man.bytes();
  const hex = await crypto.subtle.digest("SHA-256", raw as unknown as ArrayBuffer);
  const digests = new Set([`sha256:${Buffer.from(hex).toString("hex")}`]);
  try {
    const j = JSON.parse(new TextDecoder().decode(raw));
    for (const m of j.manifests ?? []) if (typeof m.digest === "string") digests.add(m.digest);
  } catch {
    /* single manifest: the raw-hash entry is all we need */
  }
  return digests;
}

export async function status(hosts: string[]) {
  // Progress goes to stderr (stdout stays a clean table paste target).
  const dbg = !!process.env.FLEET_DEBUG_STATUS;
  const t0 = performance.now();
  const progress = (s: string) =>
    console.error(`[status ${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  const verbose = (s: string) => {
    if (dbg) progress(s);
  };
  const secs = (ms: number) => (ms / 1000).toFixed(1);

  const names = allHosts(hosts);
  const svcs = serviceNames();
  // One round trip per host, and the containers name their own image instead of
  // being joined to `docker images` by ref string: a ref is only a name, so a tag
  // that moved after the container started would be credited to whatever the box
  // last pulled under it. RepoDigests stays plural after a rebuild, so match any
  // of them. `inspect` does not expand \t in --format the way `ps` does, hence
  // the pipe. Only running containers' images are resolved: only they can be
  // flagged, and a running container's image always exists while an exited one's
  // may have been pruned, which would fail the probe and lose the whole host.
  // The df tail rides the same round trip: root plus the docker dir, deduped by
  // device, as F|<mount>|<use%>|<used-1K>|<avail-1K>. The reboot marker rides
  // along too, as R|<comma-separated packages> (Debian/Ubuntu kernel postinst
  // only; a box without it simply prints nothing). The parser below matches
  // both prefixes first, so these never reach the container branch.
  const spec =
    `IDS=$(docker ps -aq --filter 'label=com.docker.compose.project') || exit 1` +
    `; R=$(docker ps -q --filter 'label=com.docker.compose.project')` +
    `; if [ -n "$R" ]; then IMGS=$(docker inspect $R --format '{{.Image}}' | sort -u)` +
    `; docker image inspect $IMGS --format 'D|{{.Id}}|{{join .RepoDigests ","}}'; fi` +
    `; if [ -n "$IDS" ]; then docker inspect $IDS --format '{{index .Config.Labels "com.docker.compose.project"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Image}}|{{.Config.Image}}'; fi` +
    `; df -P / /var/lib/docker 2>/dev/null | awk 'NR>1 && !seen[$1]++ {print "F|" $6 "|" $5 "|" $3 "|" $4}'` +
    `; if [ -e /run/reboot-required ]; then printf 'R|%s\\n' "$(tr '\\n' ',' < /run/reboot-required.pkgs 2>/dev/null)"; fi`;
  const found = new Map<string, Box[] | null>(); // host -> containers; null = unreachable
  const localDigest = new Map<string, Map<string, Set<string>>>(); // host -> image id -> digests
  const disks = new Map<string, Disk[]>(); // host -> filesystems, in df order
  const reboots = new Map<string, string[]>(); // host -> packages asking for a reboot
  const tSsh = performance.now();
  progress(`checking ${names.length} hosts...`);
  await Promise.all(
    names.map(async (name) => {
      const t = performance.now();
      // .text() captures silently (plain $ tees the remote output to the tty).
      try {
        const out = await $`${execSpec(name, spec)}`.text();
        verbose(`ssh ${name}: ${secs(performance.now() - t)}s`);
        const digests = new Map<string, Set<string>>();
        const boxes: Box[] = [];
        const hostDisks: Disk[] = [];
        for (const line of out.split("\n").filter(Boolean)) {
          const f = line.split("|");
          if (f[0] === "R") {
            reboots.set(name, [...new Set(f[1] ? f[1].split(",").filter(Boolean) : [])]);
          } else if (f[0] === "F" && f.length === 5) {
            hostDisks.push({ mount: f[1]!, pct: f[2]!, used: Number(f[3]!), avail: Number(f[4]!) });
          } else if (f[0] === "D" && f.length === 3) {
            // Repo@digest list, where the registry set holds bare digests; empty
            // for a locally built image (nothing to compare, so it never flags).
            const set = new Set(
              f[2]!
                .split(",")
                .map((d) => d.slice(d.lastIndexOf("@") + 1))
                .filter(Boolean),
            );
            if (set.size) digests.set(f[1]!, set);
          } else if (f.length === 5) {
            const [project = "", state = "", health = "", img = "", ref = ""] = f;
            boxes.push({
              project,
              state,
              healthy: health === "healthy",
              img,
              ref,
              outdated: false,
            });
          }
        }
        localDigest.set(name, digests);
        disks.set(name, hostDisks);
        found.set(name, boxes);
      } catch {
        verbose(`ssh ${name}: FAILED ${secs(performance.now() - t)}s`);
        found.set(name, null);
      }
    }),
  );
  progress(`hosts up in ${secs(performance.now() - tSsh)}s`);

  // One registry lookup per unique ref fleet-wide, then mark the boxes whose
  // host-side digest is not among the digests that ref currently serves.
  // Failures are cached too, on a shorter TTL, so one flaky registry does not
  // cost a timeout per run.
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const FAIL_TTL_MS = 60 * 1000;
  const cachePath = join(TMP_DIR, "status-cache.json");
  type CacheEntry = { t: number; d: string[] | null };
  const cache = (await Bun.file(cachePath)
    .json()
    .catch(() => ({}))) as Record<string, CacheEntry>;
  const now = Date.now();
  const fresh: Record<string, CacheEntry> = {};
  const refs = new Set<string>();
  for (const boxes of found.values())
    for (const b of boxes ?? []) if (b.state === "running" && b.ref) refs.add(b.ref);
  const remote = new Map<string, Set<string> | null>();
  let net = 0;
  const tProbes = performance.now();
  await Promise.all(
    [...refs].map(async (ref) => {
      const hit = cache[ref];
      if (hit && now - hit.t < (hit.d ? CACHE_TTL_MS : FAIL_TTL_MS)) {
        fresh[ref] = hit;
        remote.set(ref, hit.d ? new Set(hit.d) : null);
        return;
      }
      const t = performance.now();
      const d = await registryDigests(ref);
      net += 1;
      verbose(`probe ${ref}: ${d ? "ok" : "NULL"} ${secs(performance.now() - t)}s`);
      fresh[ref] = { t: now, d: d ? [...d] : null };
      remote.set(ref, d);
    }),
  );
  if (net)
    progress(`checked ${refs.size} images (${net} fresh) in ${secs(performance.now() - tProbes)}s`);
  await Bun.write(cachePath, JSON.stringify(fresh));
  for (const [name, boxes] of found) {
    const dig = localDigest.get(name);
    for (const b of boxes ?? []) {
      const mine = b.img ? dig?.get(b.img) : undefined;
      const theirs = b.ref ? remote.get(b.ref) : null;
      b.outdated = !!(mine && theirs && ![...mine].some((d) => theirs.has(d)));
    }
  }

  // console.table renders the keys as the row-index column.
  const table: Record<string, Record<string, string>> = {};
  for (const svc of svcs) {
    const scope = new Set(hostsFor(svc, []));
    const row: Record<string, string> = {};
    for (const h of names) {
      const boxes = found.get(h);
      row[h] = boxes
        ? statusCell(
            boxes.filter((b) => b.project === svc),
            scope.has(h),
          )
        : `${paint("red", WARN)} ?`;
    }
    table[svc] = row;
  }
  console.table(table);

  // One row per mount seen on any host; a host without that mount gets `.`,
  // an unreachable one `?`.
  const mounts = [...new Set(names.flatMap((h) => (disks.get(h) ?? []).map((d) => d.mount)))];
  if (mounts.length > 0) {
    const disk: Record<string, Record<string, string>> = {};
    for (const m of mounts) {
      const row: Record<string, string> = {};
      for (const h of names) {
        if (found.get(h) === null) {
          row[h] = `${paint("red", WARN)} ?`;
          continue;
        }
        const d = disks.get(h)?.find((x) => x.mount === m);
        row[h] = d ? diskCell(d) : ".";
      }
      disk[m] = row;
    }
    console.log(`\ndisk:`);
    console.table(disk);
  }

  // A box with /run/reboot-required: the packages that asked for it, or plain
  // "yes" when no .pkgs was written. A line rather than a table — package names
  // are long, and the list only grows between reboots. Advisory: like a stopped
  // container, it does not change the exit code the way an unreachable host does.
  if (reboots.size > 0) {
    console.log(`\n${paint("yellow", "reboot needed:")}`);
    const width = Math.max(...[...reboots.keys()].map((h) => h.length));
    for (const h of names) {
      const pkgs = reboots.get(h);
      if (!pkgs) continue;
      const head = pkgs.slice(0, 4).join(", ");
      const shown = pkgs.length > 4 ? `${head} (+${pkgs.length - 4} more)` : head;
      console.log(`  ${h.padEnd(width)}  ${shown || "yes"}`);
    }
  }

  // Projects running somewhere with no service.yaml (old-format stacks): same
  // host columns; cells: up / partial counts / `.`.
  const unknown = new Map<string, Map<string, { up: number; all: number; new: number }>>();
  for (const name of names) {
    for (const b of found.get(name) ?? []) {
      if (svcs.includes(b.project)) continue;
      const per = unknown.get(b.project) ?? new Map();
      const c = per.get(name) ?? { up: 0, all: 0, new: 0 };
      c.all += 1;
      if (b.state === "running") {
        c.up += 1;
        if (b.outdated) c.new += 1;
      }
      per.set(name, c);
      unknown.set(b.project, per);
    }
  }
  if (unknown.size > 0) {
    const unmanaged: Record<string, Record<string, string>> = {};
    for (const [proj, per] of [...unknown].sort()) {
      const row: Record<string, string> = {};
      for (const h of names) {
        const c = per.get(h);
        if (!c) row[h] = ".";
        else {
          const base = c.up === c.all ? "up" : c.up === 0 ? "stopped" : `${c.up}/${c.all}`;
          row[h] = c.new > 0 ? `${base} ${paint("yellow", "NEW")}` : base;
        }
      }
      unmanaged[proj] = row;
    }
    console.log(`\nunmanaged (no service.yaml):`);
    console.table(unmanaged);
  }
  const unreachable = names.filter((n) => found.get(n) === null);
  if (unreachable.length > 0) {
    console.error(`\n${paint("red", `unreachable: ${unreachable.join(", ")}`)}`);
    process.exit(1);
  }
}
