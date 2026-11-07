import { $ } from "bun";

export function fail(message: string): never {
  throw new Error(message);
}

const SNAPSHOT_SNIPPET = [
  '[ -f "/v/$1" ] || { echo "fleet: missing /v/$1" >&2; exit 1; }',
  'd=$(dirname "/.fleet/$1")',
  'mkdir -p "$d"',
  'sqlite3 "/v/$1" ".backup /.fleet/$1" && chmod 0644 "/.fleet/$1"',
].join("\n");

export async function sqlite_snapshot(args: {
  volume: string;
  db: string;
  scratch: string;
  image: string;
}): Promise<string> {
  const { volume, db, scratch, image } = args;
  // source stays read-write: sqlite coordinates the WAL -shm beside the db
  const snap =
    await $`docker run --rm -v ${volume}:/v -v ${scratch}:/.fleet --entrypoint sh ${image} -c ${SNAPSHOT_SNIPPET} sh ${db}`
      .quiet()
      .nothrow();
  if (snap.exitCode !== 0) fail(`sqlite snapshot ${volume}/${db}`);
  return `/.fleet/${db}`;
}

export async function restic(args: {
  hostname: string;
  image: string;
  env: Record<string, string>;
  mounts?: string[];
  workdir?: string;
  args: string[];
}): Promise<void> {
  const { hostname, image, env, mounts = [], workdir, args: resticArgs } = args;
  const dockerMounts = mounts.flatMap((mount) => ["-v", mount]);
  const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const workdirArgs = workdir ? ["--workdir", workdir] : [];
  const result =
    await $`docker run --rm --hostname ${hostname} ${workdirArgs} ${dockerMounts} ${envFlags} ${image} ${resticArgs}`.nothrow();
  if (result.exitCode !== 0) fail(`restic ${resticArgs[0] ?? "command"}`);
}
