// The on-box entry point: commander dispatch over the in-container jobs. The
// service jobs invoke it as `bun onbox.js <command> [args]`, with the
// scheduler's working directory as `/data`, so env files and the manifest
// resolve there.
import { Command, CommanderError } from "commander";
import { loadEnv } from "../shared/load-env";
import { main as backupVolume } from "./backup-volume";
import { main as backupPrune } from "./backup-prune";

// backup-volume expects its environment already in process.env; when a repo env
// file is given, decrypt and merge it first (the standalone load-env wrapper
// did exactly this).
async function withEnvFile(file: string, run: () => Promise<void>): Promise<void> {
  const key = Bun.env.FLEET_ENCRYPTION_KEY;
  if (!key) throw new Error("FLEET_ENCRYPTION_KEY is not set");
  const loaded = await loadEnv([file], { key, dir: process.cwd() });
  for (const [name, value] of Object.entries(loaded)) process.env[name] = value;
  await run();
}

const program = new Command().name("onbox").description("in-container backup jobs").exitOverride();

program
  .command("backup-volume")
  .argument("[envfile]", "repo-relative .env.enc to load first")
  .action(async (envfile?: string) => {
    if (envfile) await withEnvFile(envfile, backupVolume);
    else await backupVolume();
  });

program
  .command("backup-prune")
  .argument("<envfile>", "repo-relative .env.enc, decrypted from FLEET_ENCRYPTION_KEY")
  .action(async (envfile: string) => {
    await backupPrune(envfile);
  });

try {
  // Commander strips the runtime and script path itself; slicing here would
  // strip them twice and leave it with no command to dispatch.
  await program.parseAsync(Bun.argv);
} catch (e) {
  if (e instanceof CommanderError) {
    // Help and errors were already printed by Commander; honor its exit code.
    process.exit(e.exitCode);
  }
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
