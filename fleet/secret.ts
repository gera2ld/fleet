// `fleet secret edit/show`: plaintext lives only in a wiped 0600 temp file;
// the key travels via process env, never argv or disk.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { InventoryError, ROOT } from "./inv";
import { CIPHER } from "../shared/cipher";
import { decrypt } from "../shared/load-env";
import { readSecret } from "./prepare";

const KEY_NAME = "FLEET_ENCRYPTION_KEY";

function resolveSecretPath(path: string): string {
  if (!path.endsWith(".enc")) {
    throw new InventoryError(`fleet secret: '${path}': only '.enc' files`);
  }
  const abs = resolve(ROOT, path);
  const rel = relative(ROOT, abs);
  if (rel === "" || rel.startsWith("..")) {
    throw new InventoryError(`fleet secret: '${path}': must stay inside the repo`);
  }
  return abs;
}

function fail(msg: string): never {
  throw new InventoryError(msg);
}

// Spawned rather than run through `$`, which tees the child's stdout —
// stdout here is either ciphertext-adjacent or an error page, and stderr is
// inherited so a real openssl failure still explains itself.
async function openssl(args: string[], key: string): Promise<void> {
  let proc;
  try {
    proc = Bun.spawn(["openssl", ...args], {
      env: { ...process.env, [KEY_NAME]: key },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
  } catch {
    fail(`fleet secret: 'openssl' not found on PATH`);
  }
  if ((await proc.exited) !== 0) {
    fail(`fleet secret: openssl failed (wrong key or corrupt file?)`);
  }
}

const passArg = `env:${KEY_NAME}`;

async function decryptToFile(encAbs: string, outAbs: string, key: string): Promise<void> {
  await Bun.write(outAbs, await decrypt(encAbs, key));
}

// Atomic write: encrypt beside the target, then rename over it, so a failure
// (or Ctrl-C) can never leave a truncated `.enc` behind.
async function encryptToFile(inAbs: string, encAbs: string, key: string): Promise<void> {
  const staging = `${encAbs}.new-${process.pid}`;
  try {
    await openssl([...CIPHER, "-in", inAbs, "-out", staging, "-pass", passArg], key);
    await Bun.write(encAbs, Bun.file(staging));
  } finally {
    rmSync(staging, { force: true });
  }
}

// Wiped on every exit path including signals: the editor runs in the
// foreground, so a kill must not orphan the plaintext.
async function withTempPlain(run: (tmp: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-secret-"));
  let cleaned = false;
  const wipe = () => {
    if (!cleaned) {
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const onSignal = (code: number) => () => {
    wipe();
    process.exit(code);
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  try {
    await run(join(dir, "plain"));
  } finally {
    wipe();
  }
}

async function runEditor(tmp: string): Promise<void> {
  const editor = process.env.EDITOR;
  if (!editor) fail(`fleet secret: $EDITOR is not set`);
  // The inner shell word-splits $EDITOR (flags like `code --wait` work); the
  // temp path stays quoted, so spaces in $TMPDIR are safe.
  const proc = Bun.spawn(["sh", "-c", 'exec $EDITOR "$0"', tmp], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) {
    fail(`fleet secret: editor exited non-zero — original left untouched`);
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

export async function secretEdit(path: string): Promise<void> {
  const abs = resolveSecretPath(path);
  const rel = relative(ROOT, abs);
  const key = await readSecret(KEY_NAME);
  await withTempPlain(async (tmp) => {
    if (existsSync(abs) && statSync(abs).size > 0) {
      await decryptToFile(abs, tmp, key);
    } else {
      await Bun.write(tmp, "");
    }
    chmodSync(tmp, 0o600);
    const before = await Bun.file(tmp).bytes();
    await runEditor(tmp);
    const after = await Bun.file(tmp).bytes();
    if (bytesEqual(before, after) && existsSync(abs)) {
      console.log(`unchanged: ${rel}`);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    await encryptToFile(tmp, abs, key);
    console.log(`wrote ${rel}`);
  });
}

// Decrypt-then-check-then-stream: a wrong key leaves stdout empty instead of
// dumping partial CBC garbage.
export async function secretShow(path: string): Promise<void> {
  const abs = resolveSecretPath(path);
  const rel = relative(ROOT, abs);
  if (!existsSync(abs)) {
    fail(`fleet secret: '${rel}' does not exist — 'fleet secret edit ${rel}' to create it`);
  }
  const key = await readSecret(KEY_NAME);
  await withTempPlain(async (tmp) => {
    await decryptToFile(abs, tmp, key);
    chmodSync(tmp, 0o600);
    await Bun.write(Bun.stdout, Bun.file(tmp));
  });
}
