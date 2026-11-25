// Host bootstrap: idempotent units that configure the box itself, below docker.
// The shared docker networks are the built-in unit; a setup adds its own in
// `host/host.yaml` (firewall, sysctl, …). Volume creation lives in
// `setup-volumes` (per service, with seed-if-empty).
//
// A unit is a POSIX sh script, rendered on the center per host and fed to the
// box as `sh -s` on stdin. A setup's units run as root (`sudo -n` when the ssh
// user is not); the built-in one needs only docker and runs as the ssh user.
// It must describe a state, not a sequence: test, and only act on what
// differs, through the `fleet_fix` helper the preamble defines —
//
//   <is it already so?> || fleet_fix "<what is wrong>" <command that fixes it>
//
// — so the same script serves `--check` (report, change nothing) and apply
// (fix and say what changed); a converged box prints nothing.
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  EnvBlocksSchema,
  InventoryError,
  ROOT,
  TMP_DIR,
  allHosts,
  hostsFor,
  inventory,
  layerEnv,
  loadMapping,
  publicPorts,
  serviceNames,
  sshTarget,
} from "./inv";
import { execSpec, shQuote } from "./remote";

const HOST_DIR = join(ROOT, "host");
const HOST_FILE = join(HOST_DIR, "host.yaml");
const BUILTIN = "networks";
const UNIT_NAME = /^[a-z0-9][a-z0-9-]*$/;

// Exit status a unit script ends with when it found drift (--check) or fixed
// some (apply). Set by the preamble's EXIT trap; anything else non-zero fails.
const CHANGED = 3;

const HostFileSchema = z.strictObject({
  // Ordered: units run in declaration order, after the built-in networks.
  units: z
    .record(
      z.string().min(1),
      z.strictObject({
        // host/-relative; a `.tmpl` source is gomplate-rendered, anything
        // else is sent as-is.
        script: z.string().min(1),
        // Scope; absent = every server. Explicit hosts narrow it, never widen.
        servers: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .default({}),
  // Same block shape and precedence as a service manifest's env.
  env: EnvBlocksSchema.default({}),
});
type HostFile = z.output<typeof HostFileSchema>;

type Unit = { name: string; script?: string; servers?: string[] };

function hostFile(): HostFile {
  if (!existsSync(HOST_FILE)) return { units: {}, env: {} };
  const parsed = HostFileSchema.safeParse(loadMapping(HOST_FILE));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new InventoryError(`host/host.yaml: invalid: ${detail}`);
  }
  const data = parsed.data;
  const known = inventory().servers;
  for (const [name, u] of Object.entries(data.units)) {
    if (!UNIT_NAME.test(name)) {
      throw new InventoryError(`host/host.yaml: unit '${name}' must match ${UNIT_NAME}`);
    }
    if (name === BUILTIN) {
      throw new InventoryError(`host/host.yaml: unit name '${BUILTIN}' is the built-in one`);
    }
    for (const h of u.servers ?? []) {
      if (!(h in known)) {
        throw new InventoryError(`host/host.yaml: unit '${name}': server '${h}' not in inventory`);
      }
    }
    const rel = relative(ROOT, resolve(HOST_DIR, u.script));
    if (u.script.startsWith("/") || rel === "" || rel.startsWith("..")) {
      throw new InventoryError(`host/host.yaml: unit '${name}': script must stay inside the repo`);
    }
    if (!existsSync(join(HOST_DIR, u.script))) {
      throw new InventoryError(`host/host.yaml: unit '${name}': ${u.script} not found`);
    }
  }
  for (const k of Object.keys(data.env)) {
    if (k !== "default" && !(k in known)) {
      throw new InventoryError(`host/host.yaml: env block for '${k}' matches no server in inventory`);
    }
  }
  return data;
}

// gateway: the one shared network — backend discovery
// (CADDY_GEN_NETWORK=gateway) and what ingress (caddy, cloudflared) reaches
// services on. Stacks find each other by compose service name, so two
// projects on one box must not share a service name here.
// IPv6 is dropped on purpose: internal ULA cost DNS and firewall work with no
// reachability gain, since Cloudflare terminates public v6 at the edge.
function networksScript(): string {
  const gw = process.env.GW_SUBNET ?? "172.16.0.0/16";
  return [
    `docker network inspect gateway >/dev/null 2>&1 \\`,
    `  || fleet_fix "create docker network gateway" docker network create --driver bridge` +
      ` --subnet ${gw} --label project=gateway gateway`,
    "",
  ].join("\n");
}

// Env for one host: fleet default < fleet <host> < host.yaml default < host.yaml <host>.
function unitEnv(data: HostFile, host: string): Record<string, string> {
  const shared = inventory().env;
  return layerEnv(
    "host/host.yaml",
    [shared["default"], shared[host], data.env["default"], data.env[host]],
    {},
    host,
  );
}

// Every `public_ports` entry of the services scoped to this host, so a
// firewall unit opens exactly what the render gate let through.
function hostPublicPorts(host: string): string[] {
  const ports = new Set<string>();
  for (const svc of serviceNames()) {
    if (!hostsFor(svc, []).includes(host)) continue;
    for (const p of publicPorts(svc)) ports.add(p);
  }
  return [...ports].sort();
}

// No secret plugin on purpose: a host unit's rendered text lands in _tmp/ and
// travels to the box as a script, so it must not carry vault values.
async function renderUnit(unit: Unit, data: HostFile, host: string): Promise<string> {
  if (!unit.script) return networksScript();
  const src = join(HOST_DIR, unit.script);
  if (!src.endsWith(".tmpl")) return await Bun.file(src).text();
  const r = await $`gomplate -f ${src}`
    .env({
      ...process.env,
      ...unitEnv(data, host),
      FLEET_HOST: host,
      FLEET_PUBLIC_PORTS: hostPublicPorts(host).join(" "),
    })
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) {
    throw new InventoryError(`host/${unit.script} (${host}): ${r.stderr.toString().trim()}`);
  }
  const text = r.stdout.toString();
  if (text.includes("{{")) {
    throw new InventoryError(`host/${unit.script}: unrendered template marker in output`);
  }
  return text;
}

function preamble(host: string, unit: string, check: boolean): string {
  return [
    "set -eu",
    `FLEET_HOST=${shQuote(host)}; FLEET_UNIT=${shQuote(unit)}; FLEET_CHECK=${check ? 1 : 0}`,
    "FLEET_DRIFT=0",
    // fleet_fix <what is wrong> <command...>: report in --check, fix otherwise.
    "fleet_fix() {",
    "  _fleet_what=$1; shift; FLEET_DRIFT=1",
    '  if [ "$FLEET_CHECK" = 1 ]; then echo "  drift: $_fleet_what"; else echo "  fix: $_fleet_what"; "$@"; fi',
    "}",
    `trap '_fleet_rc=$?; if [ "$_fleet_rc" = 0 ] && [ "$FLEET_DRIFT" = 1 ]; then exit ${CHANGED}; fi' EXIT`,
    "",
  ].join("\n");
}

// The ssh command lines. The built-in unit needs only docker, so it runs as the
// ssh user; a setup's units configure the box and run as root. Root comes from
// the ssh user being root, passwordless sudo, or — failing both — the sudo
// password, asked once per host on the center and sent as the first line of
// the script's stdin, so it never reaches argv, ps or disk. `-k` makes sudo
// read that line even when it holds cached credentials; without it a cached
// sudo would hand the password to the shell as a command.
const AS_USER = "sh -s";
const AS_ROOT = `if [ "$(id -u)" = 0 ]; then exec sh -s; else exec sudo -n /bin/sh -s; fi`;
const AS_ROOT_PW = `exec sudo -k -S -p '' /bin/sh -s`;
const NEEDS_PW = 10;
const PROBE = `if [ "$(id -u)" = 0 ] || sudo -n /bin/sh -c true 2>/dev/null; then exit 0; else exit ${NEEDS_PW}; fi`;
const VALIDATE = `sudo -k -S -p '' -v 2>/dev/null`;

async function remote(host: string, cmd: string, stdin: string, quiet = false): Promise<number> {
  const proc = Bun.spawn(execSpec(host, `sh -c ${shQuote(cmd)}`), {
    stdin: new TextEncoder().encode(stdin),
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return await proc.exited;
}

// One line from the terminal with echo off. Refuses without a terminal: a
// cron run must have passwordless root, not hang.
async function askPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new InventoryError("setup: sudo wants a password and stdin is not a terminal");
  }
  const restore = () => Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
  const onInt = () => {
    restore();
    process.exit(130);
  };
  process.once("SIGINT", onInt);
  process.stderr.write(prompt);
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    return await new Promise<string>((res) => {
      rl.once("line", res);
      rl.once("close", () => res(""));
    });
  } finally {
    rl.close();
    restore();
    process.off("SIGINT", onInt);
    process.stderr.write("\n");
  }
}

// How root is reached on each host this run: null = no password needed. The
// last good password is offered again, for fleets that share one.
const sudoPw = new Map<string, string | null>();
let lastPw: string | undefined;

async function rootAccess(host: string): Promise<string | null> {
  if (sudoPw.has(host)) return sudoPw.get(host) ?? null;
  const probe = await remote(host, PROBE, "", true);
  if (probe === 0) {
    sudoPw.set(host, null);
    return null;
  }
  if (probe !== NEEDS_PW) throw new InventoryError(`setup: cannot reach ${host} (exit ${probe})`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const hint = lastPw !== undefined ? " (Enter = same as last)" : "";
    let pw = await askPassword(`[sudo] password for ${host}${hint}: `);
    if (pw === "" && lastPw !== undefined) pw = lastPw;
    if ((await remote(host, VALIDATE, `${pw}\n`, true)) === 0) {
      sudoPw.set(host, pw);
      lastPw = pw;
      return pw;
    }
    console.error(`sudo on ${host}: wrong password`);
  }
  throw new InventoryError(`setup: no root on ${host} after 3 tries`);
}

async function runUnit(host: string, script: string, root: boolean): Promise<number> {
  if (!root) return await remote(host, AS_USER, script);
  const pw = await rootAccess(host);
  if (pw === null) return await remote(host, AS_ROOT, script);
  return await remote(host, AS_ROOT_PW, `${pw}\n${script}`);
}

export type SetupOpts = { only?: string; check?: boolean; renderOnly?: boolean };

export async function setup(explicit: string[], opts: SetupOpts = {}) {
  const hosts = allHosts(explicit);
  if (hosts.length === 0) throw new InventoryError("no hosts selected");
  for (const h of hosts) sshTarget(h); // unknown servers fail before any box is touched
  const data = hostFile();
  let units: Unit[] = [
    { name: BUILTIN },
    ...Object.entries(data.units).map(([name, u]) => ({ name, ...u })),
  ];
  if (opts.only) {
    const wanted = opts.only
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const w of wanted) {
      if (!units.some((u) => u.name === w)) {
        throw new InventoryError(
          `setup: no unit '${w}' (have: ${units.map((u) => u.name).join(", ")})`,
        );
      }
    }
    units = units.filter((u) => wanted.includes(u.name));
  }
  const check = opts.check === true;

  // Render everything first: a template error must stop the run before the
  // first box is changed, not halfway through the fleet.
  const plan: { host: string; unit: string; script: string; root: boolean }[] = [];
  for (const host of hosts) {
    for (const u of units) {
      if (u.servers && !u.servers.includes(host)) continue;
      const script = preamble(host, u.name, check) + (await renderUnit(u, data, host));
      const preview = join(TMP_DIR, host, "_host", `${u.name}.sh`);
      mkdirSync(dirname(preview), { recursive: true });
      await Bun.write(preview, script);
      plan.push({ host, unit: u.name, script, root: u.script !== undefined });
    }
  }
  if (plan.length === 0) throw new InventoryError("setup: no unit is in scope for these hosts");
  if (opts.renderOnly) {
    for (const p of plan) console.log(`rendered _tmp/${p.host}/_host/${p.unit}.sh`);
    return;
  }

  let failed = 0;
  let changed = 0;
  let current = "";
  for (const p of plan) {
    if (p.host !== current) {
      current = p.host;
      console.log(`=== ${p.host} (${sshTarget(p.host)}) ===`);
    }
    const rc = await runUnit(p.host, p.script, p.root);
    if (rc === 0) console.log(`ok: ${p.unit}`);
    else if (rc === CHANGED) {
      changed++;
      console.log(check ? `DRIFT: ${p.unit}` : `changed: ${p.unit}`);
    } else {
      failed++;
      console.error(`FAIL: ${p.unit} on ${p.host} (exit ${rc})`);
    }
  }
  const verb = check ? "drifted" : "changed";
  console.log(`${plan.length} unit run(s): ${changed} ${verb}, ${failed} failed`);
  // --check is a gate: drift is a non-zero exit, like `secret check`.
  if (failed || (check && changed)) process.exit(1);
}
