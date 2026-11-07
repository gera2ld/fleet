// CLI dispatch: argv -> command modules. Exit codes are set by the commands.
import { Command, CommanderError } from "commander";
import { InventoryError, allHosts } from "./inv";
import { envTool, dumpBackup, resticBackup, resticRestore } from "./backup";
import { render } from "./render";
import { prepareService } from "./prepare";
import { pgRestore } from "./postgres";
import { up, restart, pushVolumes, down, setupVolumes, exec } from "./up";
import { volumeDownload, volumeRun, volumeSqliteDump, volumeUpload } from "./volume";
import { setup } from "./host";
import { status } from "./status";
import { secretCheck, secretList } from "./secrets";
import { secretEdit, secretShow } from "./secret";

// A verb with flags reads them off the third argument; serviceFlags names those.
type ServiceCommand = (svc: string, hosts: string[], opts: Record<string, unknown>) => unknown;

const serviceCommands: Record<string, ServiceCommand> = {
  render,
  up,
  restart,
  "push-volumes": pushVolumes,
  down,
  "setup-volumes": setupVolumes,
  "dump-backup": dumpBackup,
};
// Kept out of the loop so the flags land where commander documents them.
const serviceFlags: Record<string, (c: Command) => Command> = {
  up: (c) =>
    c.option("--force-recreate", "recreate the containers even if the config is unchanged"),
};
const hostCommands = {
  setup: (hosts: string[]) => setup(allHosts(hosts)),
  status,
} as const;

function build(): { program: Command; diag: () => string } {
  // Buffer what commander writes so main() can pick the stream and exit code.
  let diag = "";
  const program = new Command()
    .name("fleet")
    .description("docker compose fleet control plane")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        diag += str;
      },
      writeErr: (str) => {
        diag += str;
      },
    });

  for (const [name, fn] of Object.entries(serviceCommands)) {
    const cmd = program
      .command(name)
      .argument("<service>")
      .argument("[hosts...]", "defaults to the service's own scope");
    serviceFlags[name]?.(cmd);
    cmd.action(async (service: string, hosts: string[], ...rest: unknown[]) => {
      // With no declared options commander hands over the Command itself, hence the
      // empty-object default.
      const opts = (name in serviceFlags ? (rest[0] ?? {}) : {}) as Record<string, unknown>;
      await fn(service, hosts, opts);
    });
  }
  for (const [name, fn] of Object.entries(hostCommands)) {
    program
      .command(name)
      .argument("[hosts...]", "defaults to every inventory server")
      .action(async (hosts: string[]) => {
        await fn(hosts);
      });
  }

  // Deploy runs this with no force, so only a human can change a committed value.
  program
    .command("prepare")
    .description("derive a service's committed env from the vault (validates what is committed)")
    .argument("<service>")
    .option("--force", "regenerate, replacing the committed values")
    .action(async (service: string, opts: { force?: boolean }) => {
      await prepareService(service, { force: opts.force });
    });

  // These hand their tail to another command, so `--` is the boundary: everything
  // after it passes as-is, options before it stay ours.
  program
    .command("exec")
    .description("one-off command in a running container (stdio passthrough)")
    .argument("<service[:key]>", "compose service, or project when the project has one running")
    .argument("<host>")
    .argument("<cmd...>", "use -- before the command if it takes flags")
    .action(async (svcArg: string, host: string, cmd: string[]) => {
      const [svc = "", ...keyParts] = svcArg.split(":");
      if (keyParts.length > 1) {
        throw new InventoryError(`fleet.ts exec: too many ':' in '${svcArg}'`);
      }
      await exec(svc, keyParts[0] ?? "", host, cmd);
    });

  const volumeCmd = program
    .command("volume")
    .description("ad-hoc access to a named volume via a helper container at /v");
  volumeCmd
    .command("run")
    .description("run a command with the volume mounted at /v")
    .argument("<volume>")
    .argument("<host>")
    .argument("<cmd...>", "use -- before it if the command takes flags")
    .action(volumeRun);
  volumeCmd
    .command("download")
    .description("stream a file out of the volume to stdout")
    .argument("<volume>")
    .argument("<host>")
    .argument("<path>", "volume-root-relative")
    .action(volumeDownload);
  volumeCmd
    .command("upload")
    .description("stream a file from stdin into the volume (creates the volume if absent)")
    .argument("<volume>")
    .argument("<host>")
    .argument("<path>", "volume-root-relative")
    .action(volumeUpload);
  volumeCmd
    .command("sqlite-dump")
    .description("online sqlite snapshot to stdout (safe while the service runs)")
    .argument("<volume>")
    .argument("<host>")
    .argument("<path>", "db path inside the volume")
    .action(volumeSqliteDump);
  volumeCmd
    .command("restic-backup")
    .description("snapshot a volume's declared backup set to the restic repository")
    .argument("<volume>")
    .argument("<host>")
    .action(resticBackup);
  volumeCmd
    .command("restic-restore")
    .description("restore a volume's declared backup set (the service must be stopped)")
    .argument("<volume>")
    .argument("<host>")
    .argument("[snapshot]", "default is the volume's latest, from any host")
    .action(resticRestore);

  const secretCmd = program
    .command("secret")
    .description("vault usage report, plus decrypt/re-encrypt repo .enc files");
  secretCmd
    .command("list")
    .description("every vault secret with the projects that use it")
    .action(secretList);
  secretCmd
    .command("check")
    .description("missing / unused vault secrets (exits non-zero on drift)")
    .action(secretCheck);
  secretCmd
    .command("edit")
    .description("decrypt to a temp file, open $EDITOR, re-encrypt on save")
    .argument("<path>", "repo-relative .enc file")
    .action(secretEdit);
  secretCmd
    .command("show")
    .description("decrypt a .enc file to stdout")
    .argument("<path>", "repo-relative .enc file")
    .action(secretShow);

  // Reaches no volume (postgres_data is compose-managed), so it has no volume
  // verb to live under.
  program
    .command("pg-restore")
    .description("replay a pg_dumpall file into a FRESH EMPTY cluster")
    .argument("<file>", "a .sql dump, e.g. from a backup or a restic restore")
    .argument("<host>")
    .action(pgRestore);

  program
    .command("env")
    .description("run an arbitrary command with values from encrypted env files")
    .argument("<files-and-command...>", "repo-relative .env.enc paths, --, command and args")
    .action(async (args: string[]) => {
      await envTool(args);
    });

  return { program, diag: () => diag };
}

export async function main() {
  const { program, diag } = build();
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof InventoryError) {
      console.error(`fleet: ${e.message}`);
      process.exit(1);
    }
    if (e instanceof CommanderError) {
      // --help/--version: commander already composed the text, just emit it.
      if (e.exitCode === 0) {
        process.stdout.write(diag());
        process.exit(0);
      }
      // Bare invocation: commander asks for help rather than naming a verb.
      if (e.code === "commander.help") {
        process.stderr.write(diag());
        process.exit(1);
      }
      console.error(`fleet: ${e.message.replace(/^error: /, "")}`);
      process.exit(1);
    }
    throw e;
  }
}
