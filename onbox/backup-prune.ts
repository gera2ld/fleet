import { fail, restic } from "../shared/backup";
import { ensureEnvs } from "../shared/env";
import { loadEnv } from "../shared/load-env";

const CACHE = "fleet-restic-cache";

const REPO_KEYS = [
  "RESTIC_REPOSITORY",
  "RESTIC_PASSWORD",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_DEFAULT_REGION",
] as const;

async function loadRepoEnv(file: string, key: string) {
  try {
    return ensureEnvs(REPO_KEYS, await loadEnv([file], { key, dir: process.cwd() }));
  } catch (e) {
    fail(`${file}: ${(e as Error).message}`);
  }
}

export async function main(file: string | undefined = Bun.argv[2]): Promise<void> {
  if (!file) fail("usage: backup-prune.ts <file.env.enc>");
  const { FLEET_HOST, RESTIC_IMAGE, FLEET_ENCRYPTION_KEY } = ensureEnvs([
    "FLEET_HOST",
    "RESTIC_IMAGE",
    "FLEET_ENCRYPTION_KEY",
  ]);
  const {
    RESTIC_REPOSITORY,
    RESTIC_PASSWORD,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION,
  } = await loadRepoEnv(file, FLEET_ENCRYPTION_KEY);
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
    mounts: [`${CACHE}:/cache`],
    args: [
      "forget",
      "--prune",
      "--group-by",
      "tags",
      "--keep-daily",
      "7",
      "--keep-weekly",
      "4",
      "--keep-monthly",
      "12",
    ],
  });
}

try {
  if (import.meta.main) await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
