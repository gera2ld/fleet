import { CIPHER } from "./cipher";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function fail(message: string): never {
  throw new Error(message);
}

export type LoadEnvOptions = { key: string; dir: string };

export async function loadEnv(
  files: string[],
  opts: LoadEnvOptions,
): Promise<Record<string, string>> {
  let loaded: Record<string, string> = {};
  const root = await realpath(opts.dir);
  for (const file of files) {
    const path = resolve(opts.dir, file);
    const rel = relative(opts.dir, path);
    if (
      !file.endsWith(".env.enc") ||
      isAbsolute(file) ||
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      fail(`bad env path: ${file} (expected a repo-relative .env.enc path)`);
    }
    const real = await realpath(path);
    const realRel = relative(root, real);
    if (realRel === ".." || realRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      fail(`bad env path: ${file} resolves outside ${opts.dir}`);
    }
    loaded = { ...loaded, ...parseEnv(await decrypt(real, opts.key)) };
  }
  return loaded;
}

const USAGE = "usage: load-env.ts <file.env.enc>... -- <command> [args...]";

export async function decrypt(path: string, key: string): Promise<string> {
  const proc = Bun.spawn(
    ["openssl", ...CIPHER, "-d", "-pass", "env:FLEET_ENCRYPTION_KEY", "-in", path],
    {
      env: { ...process.env, FLEET_ENCRYPTION_KEY: key },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) fail(`cannot decrypt ${path}`);
  return text;
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let lineNo = 0;
  for (const raw of text.split("\n")) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) fail(`bad env line ${lineNo}`);
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`bad env key on line ${lineNo}`);
    const rawVal = line.slice(eq + 1).trim();
    const quoted = rawVal.match(/^(['"])(.*)\1$/);
    out[key] = quoted?.[2] ?? rawVal;
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) fail(USAGE);
  const files = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  if (files.length === 0) fail(USAGE);
  const key = Bun.env.FLEET_ENCRYPTION_KEY;
  if (!key) fail("FLEET_ENCRYPTION_KEY is not set");
  const loaded = await loadEnv(files, { key, dir: process.cwd() });
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...loaded },
  });
  process.exit((await proc.exited) ?? 1);
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
