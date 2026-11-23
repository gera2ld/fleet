import { $ } from "bun";
import { fail, restic, sqlite_snapshot } from "../shared/backup";
import { ensureEnvs } from "../shared/env";
import { loadManifest, selectVolumes } from "./manifest";

const SCRATCH = "fleet-onbox-scratch";
const CACHE = "fleet-restic-cache";

export async function main(): Promise<void> {
  const manifest = "/data/backup-manifest.json";
  const env = ensureEnvs([
    "FLEET_HOST",
    "RESTIC_REPOSITORY",
    "RESTIC_PASSWORD",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_DEFAULT_REGION",
    "SQLITE_IMAGE",
    "RESTIC_IMAGE",
  ]);
  const {
    FLEET_HOST,
    RESTIC_REPOSITORY,
    RESTIC_PASSWORD,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION,
    SQLITE_IMAGE,
    RESTIC_IMAGE,
  } = env;
  const cache = await $`docker volume create ${CACHE}`.quiet().nothrow();
  if (cache.exitCode !== 0) fail(`ensure cache volume ${CACHE}`);
  await $`docker volume rm -f ${SCRATCH}`.quiet().nothrow();
  const scratch = await $`docker volume create ${SCRATCH}`.quiet().nothrow();
  if (scratch.exitCode !== 0) fail("create scratch volume");
  try {
    for (const v of selectVolumes(await loadManifest(manifest), FLEET_HOST)) {
      const inspect = await $`docker volume inspect ${v.vol}`.quiet().nothrow();
      if (inspect.exitCode !== 0) fail(`fleet: no such volume: ${v.vol}`);
      const paths: string[] = [];
      for (const p of v.sqlite) {
        paths.push(
          await sqlite_snapshot({
            volume: v.vol,
            db: p,
            scratch: SCRATCH,
            image: SQLITE_IMAGE,
          }),
        );
      }
      for (const p of v.file) paths.push(`/${v.svc}/${p}`);
      await restic({
        hostname: FLEET_HOST,
        image: RESTIC_IMAGE,
        env: {
          RESTIC_REPOSITORY,
          RESTIC_PASSWORD,
          AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY,
          AWS_DEFAULT_REGION,
        },
        mounts: [`${SCRATCH}:/.fleet:ro`, `${v.vol}:/${v.svc}:ro`, `${CACHE}:/cache`],
        args: [
          "backup",
          "--tag",
          "fleet",
          "--tag",
          `svc=${v.svc}`,
          "--tag",
          `vol=${v.vol}`,
          ...paths,
        ],
      });
    }
  } finally {
    await $`docker volume rm -f ${SCRATCH}`.quiet().nothrow();
  }
}

try {
  if (import.meta.main) await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
