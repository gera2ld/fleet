// `fleet secret list/check`: which vault entries the fleet uses, and which it
// does not. Names only — the vault is read for its key list, never for a value,
// and the sources are the ones render would actually evaluate (compose.yml.tmpl,
// .tmpl volume sources, prepare.ts). A name mentioned in a manifest comment is
// not a use.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { InventoryError, ROOT, hostsFor, serviceNames, volumeFiles } from "./inv";

// The fnox backend is the default; point FLEET_VAULT_FILES at another
// TOML [secrets] table to reuse the report against a compatible vault.
const VAULTS = (process.env.FLEET_VAULT_FILES ?? "fnox.toml,fnox.local.toml,.fnox.local.toml")
  .split(",")
  .map((f) => join(ROOT, f));

type Use = { projects: Set<string>; perHost: boolean };

function fail(msg: string): never {
  throw new InventoryError(msg);
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`fleet secrets: cannot read ${path}`);
  }
}

// The [secrets] table of each vault file, keys only — the gitignored local
// overrides add or replace entries on a box. A proper TOML parse; only the
// keys are ever returned, never a value.
function vaultNames(): string[] {
  const names = new Set<string>();
  for (const [i, path] of VAULTS.entries()) {
    if (!existsSync(path)) {
      if (i === 0)
        fail(`fleet secrets: ${path} not found — set FLEET_VAULT_FILES or run the fnox backend`);
      continue;
    }
    const doc = parseToml(read(path)) as { secrets?: Record<string, unknown> };
    for (const name of Object.keys(doc.secrets ?? {})) names.add(name);
  }
  return [...names];
}

// What render evaluates per host. A non-.tmpl volume source is byte-copied, so
// a `secret` call inside it would never run.
function templateSources(svc: string): string[] {
  const sources = [
    join(ROOT, svc, "compose.yml.tmpl"),
    ...volumeFiles(svc).map((f) => join(ROOT, svc, f.tmpl)),
  ];
  return [...new Set(sources)].filter((p) => p.endsWith(".tmpl"));
}

const LITERAL = /\bsecret\s+"([^"]+)"/g;
const PER_HOST = /\bsecret\s+\(printf\s+"([^"%]*)%s"\s+\(strings\.ToUpper\s+\.Env\.FLEET_HOST\)/g;

// prepare.ts reads the vault through its table (`secret: "NAME"`) and, when a
// value is needed outside the table, `readSecret(...)`. Resolving a constant
// assigned a literal covers the documented `const KEY = "NAME"` shape.
function prepareNames(path: string): string[] {
  const text = read(path);
  const constants = new Map<string, string>();
  for (const m of text.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"([^"]+)"|'([^']+)')\s*;/g,
  )) {
    constants.set(m[1]!, m[2] ?? m[3]!);
  }
  const names: string[] = [];
  for (const m of text.matchAll(/\bsecret\s*:\s*(?:"([^"]+)"|'([^']+)')/g)) {
    names.push(m[1] ?? m[2]!);
  }
  for (const m of text.matchAll(/\breadSecret\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g)) {
    names.push(m[1] ?? m[2]!);
  }
  for (const m of text.matchAll(/\breadSecret\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const name = constants.get(m[1]!);
    if (name) names.push(name);
  }
  return names;
}

type Row = {
  secret: string;
  missing: boolean;
  unused: boolean;
  projects: string;
  tags: string;
};

function report(): { rows: Row[]; vault: number } {
  const vault = new Set(vaultNames());
  const uses = new Map<string, Use>();
  const use = (name: string, svc: string, perHost: boolean) => {
    const entry = uses.get(name) ?? { projects: new Set<string>(), perHost: false };
    entry.projects.add(svc);
    entry.perHost ||= perHost;
    uses.set(name, entry);
  };

  for (const svc of serviceNames()) {
    const hosts = hostsFor(svc, []);
    for (const path of templateSources(svc)) {
      // Gomplate comments are never evaluated; everything else in the file is.
      const text = read(path).replace(/{{-?\s*\/\*[\s\S]*?\*\/\s*-?}}/g, "");
      for (const m of text.matchAll(LITERAL)) use(m[1]!, svc, false);
      for (const m of text.matchAll(PER_HOST)) {
        // FLEET_HOST is the renderer's own value: the name exists once per host
        // in the service's scope, uppercase by the naming convention.
        for (const host of hosts) use(`${m[1]}${host.toUpperCase()}`, svc, true);
      }
    }
    const prepare = join(ROOT, svc, "prepare.ts");
    if (existsSync(prepare)) {
      for (const name of prepareNames(prepare)) use(name, svc, false);
    }
  }

  const rows = [...new Set([...vault, ...uses.keys()])].map((secret) => {
    const entry = uses.get(secret);
    const missing = !vault.has(secret);
    const unused = !entry;
    const tags: string[] = [];
    if (missing) tags.push("missing");
    if (unused) tags.push("unused");
    if (entry?.perHost) tags.push("per-host");
    return {
      secret,
      missing,
      unused,
      projects: entry ? [...entry.projects].sort().join(", ") : "-",
      tags: tags.join(", "),
    };
  });
  return { rows, vault: vault.size };
}

function print(rows: Row[]): void {
  rows.sort((a, b) => Number(b.missing) - Number(a.missing) || a.secret.localeCompare(b.secret));
  console.table(rows.map(({ secret, projects, tags }) => ({ secret, projects, tags })));
}

// Every entry, referenced or not.
export async function secretList(): Promise<void> {
  const { rows, vault } = report();
  if (rows.length === 0) {
    console.log(`no secrets in the vault (${vault} entries)`);
    return;
  }
  print(rows);
}

// Only the drift, and a non-zero exit so it can gate a deploy or CI: "unused"
// is as much a decision to make as "missing".
export async function secretCheck(): Promise<void> {
  const { rows, vault } = report();
  const drift = rows.filter((r) => r.missing || r.unused);
  if (drift.length === 0) {
    console.log(`no drift: all ${vault} vault secret(s) are referenced`);
    return;
  }
  print(drift);
  process.exitCode = 1;
}
