#!/usr/bin/env bun
// Fleet inventory. Two sources, each with one job:
//   fleet.yaml            servers (name -> ssh target) + shared env defaults
//   <svc>/service.yaml    manifest + env: default: {...}, <host>: {...}
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ROOT } from "./paths";

export { CLI, ROOT, SCRIPTS, TMP_DIR, ENV_DIR, SECRET_PLUGIN } from "./paths";

// A server whose target is this sentinel is the machine running the center:
// commands run directly, no ssh. Declare it per-box in fleet.local.yaml.
export const LOCAL_TARGET = "localhost";

export class InventoryError extends Error {}

function fail(msg: string): never {
  throw new InventoryError(msg);
}

export function loadMapping(path: string, optional = false): Record<string, unknown> {
  if (!existsSync(path)) {
    if (optional) return {};
    fail(`${path} not found`);
  }
  let doc: unknown;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`${path}: invalid YAML: ${e instanceof Error ? e.message : e}`);
  }
  if (doc == null) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    fail(`${path}: top level must be a mapping`);
  }
  return doc as Record<string, unknown>;
}

// fleet.yaml is committed (fleet-wide truth); fleet.local.yaml is gitignored,
// per-box, and wins key by key at every level — connections that differ from
// this machine, and the self-declaration `<name>: localhost`.
function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = isMap(cur) && isMap(v) ? deepMerge(cur, v) : v;
  }
  return out;
}

// Scalar env values only; numbers/booleans stringify (e.g. PORT: 8080).
const EnvBlocksSchema = z.record(
  z.string(),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
);
export type EnvBlock = z.output<typeof EnvBlocksSchema>[string];

const InventorySchema = z.strictObject({
  // name -> ssh target (empty targets fail at sshTarget, like before).
  servers: z.record(z.string().min(1), z.string()),
  env: EnvBlocksSchema.default({}),
});

export type Inventory = { servers: Record<string, string>; env: Record<string, EnvBlock> };

export function inventory(): Inventory {
  const doc = deepMerge(
    loadMapping(join(ROOT, "fleet.yaml")),
    loadMapping(join(ROOT, "fleet.local.yaml"), true),
  );
  const parsed = InventorySchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    fail(`fleet.yaml: invalid: ${detail}`);
  }
  const { servers, env } = parsed.data;
  if ("default" in servers) fail(`fleet(.local).yaml: 'default' is reserved, rename that server`);
  for (const k of Object.keys(env)) {
    if (k !== "default" && !(k in servers)) {
      fail(`fleet.yaml: env block for '${k}' matches no server in inventory`);
    }
  }
  return { servers, env };
}

export function servers(): Record<string, string> {
  return inventory().servers;
}

// Missing or empty fails loud — never silently run whatever `:latest`
// happens to be.
export function fleetImage(name: string): string {
  const v = inventory().env["default"]?.[name];
  if (v === undefined || String(v) === "") {
    fail(`fleet.yaml: env.default.${name} is not set`);
  }
  return String(v);
}

// `writable` marks a volume the app writes itself; `files` maps volume paths to
// repo templates. `backup` is what `fleet volume restic-backup` snapshots:
// `sqlite` entries get an online .backup copy (safe while the service runs),
// `file` entries are read as they are and may be a directory. It is `file`,
// not `files`, because the push mapping above owns that name.
const VolumeSpecSchema = z.object({
  writable: z.boolean().default(false),
  files: z.record(z.string().min(1), z.string().min(1)).default({}),
  // strict: a mistyped shape (say the old `{path: kind}`) would otherwise parse
  // as two empty lists and quietly back up nothing.
  backup: z.preprocess(
    (v) => v ?? {},
    z.strictObject({
      sqlite: z.array(z.string().min(1)).default([]),
      file: z.array(z.string().min(1)).default([]),
    }),
  ),
});
const VolumeSchema = z.preprocess((v) => v ?? {}, VolumeSpecSchema);

const ServiceFileSchema = z.strictObject({
  // Compose template is always <svc>/compose.yml.tmpl by convention.
  // External volumes: the key is the LITERAL volume name (matching the tmpl's
  // external volume). `up` gates on it, `setup-volumes` creates it. A files
  // target ending in `/` maps a whole repo directory preserving relative paths
  // (`conf.d/: config/conf.d/`, `/: config/`); seed empty dirs with a .gitkeep.
  // Compose-managed data volumes are NOT declared here: their real name is
  // <project>_<key>, so setup could not create them.
  // `writable`: the app rewrites what we push, so the files get 666 and their
  // directories 777 instead of 444. The fleet never chowns — a container's uid
  // is its image's business, and pinning one here would rot when the image
  // changes it.
  volumes: z.record(z.string().min(1), VolumeSchema).default({}),
  // Backups that are not volume files: a logical dump of a live database. It
  // belongs here rather than under a volume because the data volume of such a
  // service is compose-managed, so there is no name we could declare. Each cmd
  // runs inside the service's own container, where the local socket and
  // credentials already are, and its stdout lands in the snapshot as
  // /<svc>/dumps/<name>.
  backup: z.preprocess(
    (v) => v ?? {},
    z.strictObject({
      dumps: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            cmd: z.array(z.string().min(1)).min(1),
            // Compose service label; required when the project runs more than one.
            service: z.string().min(1).optional(),
          }),
        )
        .default([]),
    }),
  ),
  // Deploy scope: explicit list, or all servers when absent.
  servers: z.array(z.string().min(1)).min(1).optional(),
  // Same block shape as the shared `env` in fleet.yaml (see EnvBlocksSchema).
  env: EnvBlocksSchema.default({}),
});
export type ServiceFile = z.output<typeof ServiceFileSchema>;

export function service(svc: string): ServiceFile {
  const path = join(ROOT, svc, "service.yaml");
  const parsed = ServiceFileSchema.safeParse(loadMapping(path));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    fail(`${svc}/service.yaml: invalid: ${detail}`);
  }
  const data = parsed.data;
  const known = servers();
  if (data.servers) {
    for (const h of data.servers) {
      if (!(h in known)) fail(`${svc}/service.yaml: server '${h}' not in fleet inventory`);
    }
  }
  for (const k of Object.keys(data.env)) {
    if (k !== "default" && !(k in known)) {
      fail(`${svc}/service.yaml: env block for '${k}' matches no server in inventory`);
    }
  }
  for (const [vol, spec] of Object.entries(data.volumes)) {
    for (const paths of Object.values(spec.backup)) {
      for (const p of paths) checkBackupPath(`${svc}/service.yaml`, vol, p);
    }
  }
  for (const d of data.backup.dumps) {
    if (!/^[A-Za-z0-9._-]+$/.test(d.name) || d.name.startsWith(".")) {
      fail(
        `${svc}/service.yaml: dump name '${d.name}' must be a plain file name, volume-path rules do not apply`,
      );
    }
  }
  // A derived env nobody re-derives is just a committed value that rots.
  if (
    existsSync(join(ROOT, svc, "generated-envs.json")) &&
    !existsSync(join(ROOT, svc, "prepare.ts"))
  ) {
    fail(`${svc}/generated-envs.json: no prepare.ts beside it — nothing validates that file`);
  }
  return data;
}

// Every service in the fleet: top-level dirs holding a service.yaml
// (`_`/`.`-prefixed infrastructure dirs are skipped).
export function serviceNames(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .filter((d) => existsSync(join(ROOT, d.name, "service.yaml")))
    .map((d) => d.name)
    .sort();
}

export function sshTarget(name: string): string {
  const target = servers()[name];
  if (typeof target !== "string" || target === "") {
    fail(`unknown server '${name}' (not in fleet inventory)`);
  }
  return target;
}

// True when this server is the box running the center.
export function isLocal(name: string): boolean {
  return sshTarget(name) === LOCAL_TARGET;
}

// Host selection: explicit names always win; empty means the default set
// (all servers, or the service's scope). A `localhost` target changes only
// HOW the box is reached, never WHETHER it is in scope. Fails loud on
// unknown servers happens later at sshTarget() — same contract as lib.sh.
export function allHosts(explicit: string[]): string[] {
  return explicit.length > 0 ? explicit : Object.keys(servers());
}

// Explicit hosts always win; empty means the service's own scope, or every
// inventory server when it declares none. A `localhost` target changes only HOW
// a box is reached, never whether it is in scope.
export function hostsFor(svc: string, explicit: string[]): string[] {
  if (explicit.length > 0) return explicit;
  return service(svc).servers ?? Object.keys(servers());
}

// Per-service generated env: committed values derived from the vault by
// <svc>/prepare.ts. Absent for services that have none.
function generatedEnv(svc: string): Record<string, string> {
  const path = join(ROOT, svc, "generated-envs.json");
  if (!existsSync(path)) return {};
  const parsed = z.record(z.string(), z.string()).safeParse(loadMapping(path, true));
  if (!parsed.success) {
    fail(`${path}: expected a flat map of string values — run ${svc}/prepare.ts`);
  }
  return parsed.data;
}

// Env for rendering, layered (AGENTS.md has the precedence table): generated env
// under the fleet's shared env under the manifest's own blocks. Process env is
// deliberately not consulted — renders stay deterministic and per-host, and
// gomplate fails hard on a missing .Env key.
// A value may reference another key as $NAME or ${NAME} ($$ is a literal $),
// resolved against the merged per-host map; unknown names and cycles fail loud.
export function envFor(svc: string, host?: string): Record<string, string> {
  const merged: Record<string, string> = {};
  const PLACEHOLDER = "\x00DOLLAR\x00";
  // Generated values are literal, never interpolated: a hash is full of `$` and
  // the reference pass below would read those as key names.
  for (const [k, v] of Object.entries(generatedEnv(svc))) {
    merged[k] = v.replaceAll("$", PLACEHOLDER);
  }
  const assign = (block: EnvBlock | undefined) => {
    if (!block) return;
    for (const [k, v] of Object.entries(block)) merged[k] = String(v);
  };
  if (host && !(host in servers())) fail(`unknown server '${host}' (not in fleet inventory)`);
  const data = service(svc);
  const shared = inventory().env;
  assign(shared["default"]);
  if (host) assign(shared[host]);
  assign(data.env["default"]);
  if (host) assign(data.env[host]);
  const scope = host ? ` for host '${host}'` : "";
  for (const k of Object.keys(merged)) {
    const cur = merged[k];
    if (cur === undefined) fail(`${svc}/service.yaml: missing env value for '${k}'`);
    merged[k] = cur.replace(/\$\$/g, PLACEHOLDER);
  }
  const resolved: Record<string, string> = {};
  const resolve = (key: string, trail: string[]): string => {
    const cached = resolved[key];
    if (cached !== undefined) return cached;
    if (trail.includes(key))
      fail(`${svc}/service.yaml: circular env reference: ${[...trail, key].join(" -> ")}`);
    const raw = merged[key];
    if (raw === undefined) fail(`${svc}/service.yaml: missing env value for '${key}'`);
    const expanded = raw.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_m, braced: string | undefined, plain: string | undefined) => {
        const name = (braced ?? plain) as string;
        if (!(name in merged)) {
          fail(
            `${svc}/service.yaml: env '${trail[0] ?? key}'${scope} references unknown key '${name}'`,
          );
        }
        return resolve(name, [...trail, key]);
      },
    );
    resolved[key] = expanded;
    return expanded;
  };
  for (const k of Object.keys(merged)) resolve(k, []);
  for (const k of Object.keys(resolved)) {
    const val = resolved[k];
    if (val === undefined) fail(`${svc}/service.yaml: missing env value for '${k}'`);
    merged[k] = val.replaceAll(PLACEHOLDER, "$");
  }
  return merged;
}

export type VolumeFile = { vol: string; target: string; tmpl: string };

// Volume-root-relative and plain: these strings are spliced into a remote shell
// script and a container payload, so the allowlist is what keeps that safe.
const VOLUME_PATH = /^[A-Za-z0-9._/-]+$/;

function checkVolumeTarget(svc: string, vol: string, target: string): void {
  if (target === "/") return; // volume root: sync a dir straight into it
  if (target.startsWith("/") || target.includes("..")) {
    fail(
      `${svc}/service.yaml: volume '${vol}': target '${target}' must be volume-relative without '..'`,
    );
  }
}

// Sources usually sit beside the manifest; shared files (../_shared/) resolve
// anywhere inside the repo, never outside it.
function checkVolumeSource(svc: string, vol: string, rawTmpl: string): void {
  if (rawTmpl.startsWith("/")) {
    fail(`${svc}/service.yaml: volume '${vol}': source '${rawTmpl}' must be repo-relative`);
  }
  const rel = relative(ROOT, resolve(ROOT, svc, rawTmpl));
  if (rel === "" || rel.startsWith("..")) {
    fail(`${svc}/service.yaml: volume '${vol}': source '${rawTmpl}' escapes the repo`);
  }
}

// A volume path in a manifest backup list. `/.fleet/` is where a backup stages
// its sqlite snapshots, so a declared path there could not be told apart from
// staging on the way back out.
function checkBackupPath(where: string, vol: string, p: string): string {
  if (
    !VOLUME_PATH.test(p) ||
    p.startsWith("/") ||
    p.includes("..") ||
    p.split("/")[0] === ".fleet"
  ) {
    fail(
      `${where}: volume '${vol}': backup path '${p}' must be plain and volume-relative (no leading '/', no '..', not under .fleet/)`,
    );
  }
  return p;
}

// Checkouts, dependency trees and Finder droppings are never app config: a
// volume mapping that points at a repo would otherwise push its .git file and
// node_modules wholesale.
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

function walkDir(abs: string): string[] {
  const rels: string[] = [];
  const walk = (dir: string, prefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (e.isFile()) rels.push(rel);
      // Anything else (symlink, socket, …) is not pushed.
    }
  };
  walk(abs, "");
  return rels;
}

export function volumeFiles(svc: string): VolumeFile[] {
  const out: VolumeFile[] = [];
  for (const [vol, spec] of Object.entries(service(svc).volumes)) {
    for (const [rawTarget, rawTmpl] of Object.entries(spec.files)) {
      checkVolumeTarget(svc, vol, rawTarget);
      checkVolumeSource(svc, vol, rawTmpl);
      if (rawTarget.endsWith("/")) {
        const targetBase = rawTarget === "/" ? "" : rawTarget.replace(/\/+$/, "/");
        const tmplBase = rawTmpl.replace(/\/+$/, "");
        if (!tmplBase)
          fail(`${svc}/service.yaml: volume '${vol}': directory mapping needs a source dir`);
        const abs = join(ROOT, svc, tmplBase);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          fail(`${svc}/service.yaml: volume '${vol}': '${rawTmpl}' is not a directory`);
        }
        for (const rel of walkDir(abs)) {
          out.push({ vol, target: `${targetBase}${rel}`, tmpl: posix.join(tmplBase, rel) });
        }
      } else {
        out.push({ vol, target: rawTarget, tmpl: rawTmpl });
      }
    }
  }
  const seen = new Set<string>();
  for (const f of out) {
    const key = JSON.stringify([f.vol, f.target]);
    if (seen.has(key)) {
      fail(`${svc}/service.yaml: volume '${f.vol}': target '${f.target}' has more than one source`);
    }
    seen.add(key);
  }
  out.sort((a, b) =>
    a.vol < b.vol ? -1 : a.vol > b.vol ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  return out;
}

export type BackupKind = "sqlite" | "file";
export type BackupEntry = { vol: string; path: string; kind: BackupKind };

// The declared backup entries: sqlite first, then plain files, each in
// declaration order.
export function backupEntries(svc: string, vol: string): BackupEntry[] {
  const spec = service(svc).volumes[vol];
  if (!spec) fail(`${svc}: no volume '${vol}'`);
  const entry =
    (kind: BackupKind) =>
    (p: string): BackupEntry => ({
      vol,
      path: checkBackupPath(`${svc}/service.yaml`, vol, p),
      kind,
    });
  const { sqlite, file } = spec.backup;
  return [...sqlite.map(entry("sqlite")), ...file.map(entry("file"))];
}

export function hasBackup(svc: string, vol: string): boolean {
  return backupEntries(svc, vol).length > 0;
}

export type DumpEntry = { name: string; cmd: string[]; service?: string };

// The declared dumps of a service, in declaration order.
export function dumpEntries(svc: string): DumpEntry[] {
  return service(svc).backup.dumps;
}
