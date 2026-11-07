#!/usr/bin/env bun
// Fleet control, center side: render / up / restart / push-volumes / down / volume / setup.
// Remotes need only ssh + docker — files travel as strings over ssh stdin,
// no repo checkout and no host env files on servers.
// Secrets resolve only inside rendered _tmp/ files (gomplate secret plugin);
// nothing here ever prints a resolved value.
// Implementation lives in fleet/: cli (dispatch), remote (ssh/local exec
// helpers), render, up (up/push-volumes/down/setup-volumes/exec), volume,
// backup (restic), host (setup), status, secrets (secret list/check).
// `fleet.ts --help` lists the commands; `fleet.ts <command> --help` the
// arguments. For exec / volume / env, everything after `--` is passed through
// untouched, so a container command may take its own flags.
import { main } from "./fleet/cli";

await main();
