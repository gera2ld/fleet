// Where the tool is, where the setup is, and the few directories the setup
// declares. Everything else is derived from these.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The engine checkout: this file sits in its `fleet/` directory, so its parent
// is the package root — wherever the package is installed. The setup root is
// independent — see below.
export const SCRIPTS = dirname(import.meta.dir);

// The setup root. FLEET_ROOT wins (cron, wrappers); otherwise walk up from the
// invocation directory until fleet.yaml appears. When there is none yet (for
// example, a bare `--help` from this repo), stay put.
function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "fleet.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export const ROOT = process.env.FLEET_ROOT
  ? resolve(process.env.FLEET_ROOT)
  : findRoot(process.cwd());

export const TMP_DIR = process.env.FLEET_TMP_DIR ?? join(ROOT, "_tmp");
export const ENV_DIR = process.env.FLEET_ENV_DIR ?? join(ROOT, "_envs");

// A secret provider is an executable that takes a name and prints its value.
// The shipped one uses fnox; set FLEET_SECRET_PLUGIN to use another vault.
export const SECRET_PLUGIN = process.env.FLEET_SECRET_PLUGIN ?? join(SCRIPTS, "secret.sh");

// How messages name the command, so hints stay right whether the tool is run
// directly, through `just fleet`, or from a wrapper.
export const CLI = process.env.FLEET_CLI ?? "fleet";
