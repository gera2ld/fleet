// Logical restore for the compose-managed postgres: `pg_dumpall` output cannot
// be replayed into a cluster that already holds databases, so this refuses
// rather than half-restoring one.
//
// Two subtleties the shell version kept tripping over:
//   - The dump's `CREATE ROLE postgres;` collides with the bootstrap superuser
//     that initdb always creates, so ON_ERROR_STOP can never be on: replay runs
//     without it and the errors are classified afterwards. Only duplicate-object
//     errors are tolerated; anything else fails and says the cluster may be
//     partly restored.
//   - `containerLookup` resolves the running container by compose label, and the
//     local socket means no password and a client that matches the server.
import { existsSync } from "node:fs";
import { InventoryError, service, sshTarget } from "./inv";
import { containerLookup, execSpec, shQuote } from "./remote";

const SERVICE = "postgres";
// A cluster the image initialised holds `postgres` and nothing else.
const FRESH_DATABASES = 1;

const COUNT_DBS = "SELECT count(*) FROM pg_database WHERE NOT datistemplate";

// Runs psql inside the service's container. `sql` null means "read the script
// from stdin", which is how a dump is replayed — Bun.spawn streams it from disk
// rather than reading 17 MB into memory, and captures stderr so the errors can
// be classified instead of scrolling past.
async function psql(
  host: string,
  sql: string | null,
  file?: string,
): Promise<{ code: number; out: string; err: string }> {
  const script =
    containerLookup(SERVICE, "") +
    (sql === null
      ? `\ndocker exec -i "$c" psql -q -U postgres`
      : `\ndocker exec "$c" psql -tAU postgres -c ${shQuote(sql)}`);
  const proc = Bun.spawn({
    cmd: execSpec(host, script),
    ...(file ? { stdin: Bun.file(file) } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? 0, out, err };
}

// pg-restore <file> <host>
export async function pgRestore(file: string, host: string) {
  service(SERVICE); // unknown service fails like everywhere else
  sshTarget(host); // fail early on unknown server
  if (!existsSync(file)) throw new InventoryError(`pg-restore: no such file: ${file}`);

  const before = await psql(host, COUNT_DBS);
  const n = Number(before.out.trim());
  if (before.code !== 0 || !Number.isInteger(n)) {
    throw new InventoryError(
      `pg-restore: could not count databases on ${host} — is it in the inventory and up?`,
    );
  }
  if (n !== FRESH_DATABASES) {
    throw new InventoryError(
      `pg-restore: ${host} has ${n} non-template databases (a fresh cluster has exactly ${FRESH_DATABASES}) — restore into an empty one`,
    );
  }

  const replay = await psql(host, null, file);
  const errors = replay.err.split("\n").filter((l) => l.startsWith("ERROR:"));
  const fatal = errors.filter((l) => !l.includes("already exists"));
  if (replay.code !== 0 || fatal.length > 0) {
    const detail = fatal.length > 0 ? fatal : replay.err.trim().split("\n");
    throw new InventoryError(
      `pg-restore: replay failed on ${host}, the cluster may be partly restored:\n${detail.join("\n")}`,
    );
  }
  for (const e of errors) console.error(`pg-restore: tolerated ${e}`);
  console.log(`pg-restore: restored ${file} into ${host} (${errors.length} tolerated)`);
}
