// The on-box entry point: commander dispatch over the in-container jobs. The
// service jobs invoke it as `bun onbox.js <command> [args]`, with the
// scheduler's working directory as `/data`, so env files and the manifest
// resolve there.
import { Command, CommanderError } from "commander";
import { loadEnv } from "../shared/load-env";
import { main as backupDb } from "./backup-db";
import { main as backupPrune } from "./backup-prune";

// backup-db expects its environment already in process.env; when a repo env
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
  .command("backup-db")
  .argument("[envfile]", "repo-relative .env.enc to load first")
  .action(async (envfile?: string) => {
    if (envfile) await withEnvFile(envfile, backupDb);
    else await backupDb();
  });

program
  .command("backup-prune")
  .argument("<envfile>", "repo-relative .env.enc, decrypted from FLEET_ENCRYPTION_KEY")
  .action(async (envfile: string) => {
    await backupPrune(envfile);
  });

try {
  await program.parseAsync(Bun.argv.slice(2));
} catch (e) {
  if (e instanceof CommanderError) {
    // With exitOverride, help is thrown with code 1 — and a missing argument
    // throws the same code. An explicit --help exits 0, anything else is an
    // error, so distinguish by whether help was actually asked for.
    const askedHelp = Bun.argv.some((a) => a === "--help" || a === "-h" || a === "help");
    if (e.code === "commander.help" && askedHelp) process.exit(0);
    if (e.code === "commander.help") process.exit(1);
    console.error(e.message.replace(/^error: /, ""));
    process.exit(1);
  }
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
