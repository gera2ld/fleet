// <svc>/prepare.ts derives committed, verifiable values into
// <svc>/generated-envs.json, which envFor in inv merges into .Env. A
// service's own prepare.ts is a table plus the kinds only it needs; the
// generate/verify flow, the vault read and the host-independent env view live
// here. Deploy runs it before rendering, `down` does not.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CLI, envFor, InventoryError, loadMapping, ROOT, SECRET_PLUGIN } from "./inv";

// `secret` names a vault entry, `env` a manifest env key — exactly one of them.
// Env-sourced rows exist because some inputs are configuration, not secrets.
export type Row = { key: string; kind: string; secret?: string; env?: string };

// `env` is the host-independent merged env: prepare runs once per render, so a
// derived value cannot vary by host.
export type Env = Record<string, string>;

// A kind must be able to say whether a committed value still follows from its
// input — that check is what makes a committed value trustworthy rather than a
// stale artifact nobody notices. `verify` inverts `derive` when the transform
// is randomised.
type Awaitable<T> = T | Promise<T>;

export type Kind = {
  derive(input: string, env: Env): Awaitable<string>;
  verify(input: string, value: string, env: Env): Awaitable<boolean>;
};

const KINDS: Record<string, Kind> = {
  bcrypt: {
    derive: (input) => Bun.password.hash(input, { algorithm: "bcrypt" }),
    verify: (input, value) => Bun.password.verify(input, value),
  },
};

export type Table = { rows: Row[]; kinds?: Record<string, Kind> };

// Identity, so a service's table gets its types without importing them.
export function define(rows: Row[], kinds?: Record<string, Kind>): Table {
  return { rows, kinds };
}

// The render-time plugin, reused so the vault contract (fail loud when unset,
// never print the value) stays defined in one place. Spawned rather than run
// through `$`, which tees a child's stdout as it goes — that would print the
// secret.
export async function readSecret(name: string): Promise<string> {
  const proc = Bun.spawn(["sh", SECRET_PLUGIN, name], { stdout: "pipe", stderr: "inherit" });
  const value = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new InventoryError(`secret '${name}' is not readable (see above)`);
  return value;
}

function envPath(svc: string): string {
  return join(ROOT, svc, "generated-envs.json");
}

function readEnv(svc: string): Record<string, string> {
  const path = envPath(svc);
  if (!existsSync(path)) return {};
  const parsed = z.record(z.string(), z.string()).safeParse(loadMapping(path, true));
  if (!parsed.success)
    fail(`${path}: expected a flat map of string values — run ${svc}/prepare.ts`);
  return parsed.data;
}

function fail(msg: string): never {
  throw new InventoryError(msg);
}

// The file is a pure function of (table, inputs): present and not forced means
// prove it, absent means write it. A deploy asks for no force, so it can create
// this file but never rewrite one.
export async function run(
  svc: string,
  table: Table,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (table.rows.length === 0) return;
  const kinds = { ...KINDS, ...table.kinds };
  const env = envFor(svc);
  const input = async (row: Row): Promise<string> => {
    if (row.secret !== undefined) return await readSecret(row.secret);
    if (row.env !== undefined) {
      const value = env[row.env];
      if (value === undefined) fail(`${svc}: env '${row.env}' is not set — needed by '${row.key}'`);
      return value;
    }
    return fail(`${svc}/prepare.ts: '${row.key}' names neither a secret nor an env key`);
  };
  const rows = table.rows.map((row) => {
    const kind = kinds[row.kind];
    if (!kind) fail(`${svc}/prepare.ts: unknown kind '${row.kind}' for '${row.key}'`);
    return { row, kind };
  });
  const path = envPath(svc);
  if (existsSync(path) && !opts.force) {
    const current = readEnv(svc);
    for (const { row, kind } of rows) {
      const value = current[row.key];
      if (value === undefined) {
        fail(`${path}: no '${row.key}' — regenerate: ${CLI} prepare ${svc} --force`);
      }
      if (!(await kind.verify(await input(row), value, env))) {
        fail(
          `${path}: '${row.key}' no longer follows its input — regenerate: ${CLI} prepare ${svc} --force`,
        );
      }
    }
    if (rows.length > 0) console.log(`prepare: ${svc} validated ${rows.length} value(s)`);
    return;
  }
  const out: Record<string, string> = {};
  for (const { row, kind } of rows) out[row.key] = await kind.derive(await input(row), env);
  // Written through a temp name: a render running alongside must never read a
  // half-written file. Sorted keys keep the committed diff stable.
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(Object.fromEntries(Object.entries(out).sort()), null, 2) + "\n",
  );
  renameSync(tmp, path);
  console.log(`prepare: wrote ${svc} (${Object.keys(out).length} value(s))`);
}

export type ValidateCtx = {
  host: string;
  /** _tmp/<host>/<svc> — holds the rendered compose.yml. */
  root: string;
  /** the same env the host's files were rendered with. */
  env: Record<string, string>;
  /** staged directory of one declared volume, for mounting. */
  dirFor(vol: string): string;
};
export type ValidateFn = (ctx: ValidateCtx) => Promise<void>;
export type PrepareFn = () => Promise<void> | void;
export type ServiceHook = { default: Table; prepare?: PrepareFn; validate?: ValidateFn };

export async function loadService(svc: string): Promise<ServiceHook | undefined> {
  const mod = join(ROOT, svc, "prepare.ts");
  if (!existsSync(mod)) return undefined;
  const loaded = (await import(mod)) as Partial<ServiceHook>;
  const table = loaded.default;
  if (typeof table !== "object" || table === null || !Array.isArray((table as Table).rows)) {
    fail(`${mod}: must default-export define([...]) from the fleet prepare module`);
  }
  if (loaded.validate !== undefined && typeof loaded.validate !== "function") {
    fail(`${mod}: 'validate' must be a function`);
  }
  if (loaded.prepare !== undefined && typeof loaded.prepare !== "function") {
    fail(`${mod}: 'prepare' must be a function`);
  }
  if ((table as Table).rows.length === 0 && !loaded.validate && !loaded.prepare) {
    fail(`${mod}: empty table and no validate() — nothing for the fleet to do`);
  }
  return loaded as ServiceHook;
}

// Deploy path and the `prepare` verb both come through here.
export async function prepareService(svc: string, opts: { force?: boolean } = {}): Promise<void> {
  const hook = await loadService(svc);
  if (!hook) {
    if (opts.force) fail(`${svc}: no prepare.ts — nothing to prepare`);
    return;
  }
  await runService(svc, hook, opts);
}

export async function runService(
  svc: string,
  hook: ServiceHook,
  opts: { force?: boolean } = {},
): Promise<void> {
  await hook.prepare?.();
  await run(svc, hook.default, opts);
}

// Env goes in on stdin as `--env-file /dev/stdin`, so no value reaches argv, ps
// or disk. stdout is dropped: these tools print everything on success, and
// stderr is what carries a failure.
export async function dockerValidate(opts: {
  image: string;
  cmd: string[];
  mounts: { from: string; to: string }[];
  env: Record<string, string>;
  entrypoint?: string;
}): Promise<void> {
  const args = ["docker", "run", "--rm", "-i"];
  if (opts.entrypoint) args.push("--entrypoint", opts.entrypoint);
  for (const m of opts.mounts) args.push("-v", `${m.from}:${m.to}`);
  args.push("--env-file", "/dev/stdin", opts.image, ...opts.cmd);
  const envFile = `${Object.entries(opts.env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: args,
      stdin: new Blob([envFile]),
      stdout: "ignore",
      stderr: "inherit",
    });
  } catch (e) {
    // Render is otherwise pure; it must not hard-require a daemon.
    console.warn(
      `validate: cannot run ${opts.image}, skipping (${e instanceof Error ? e.message : e})`,
    );
    return;
  }
  const code = await proc.exited;
  if (code !== 0) {
    fail(`validation failed (exit ${code}): ${opts.image} ${opts.cmd.join(" ")}`);
  }
}
