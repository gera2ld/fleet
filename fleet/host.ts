// Host bootstrap: the shared docker networks, nothing else. Volume creation
// lives in `setup-volumes` (per service, with seed-if-empty).
import { $ } from "bun";
import { InventoryError, sshTarget } from "./inv";
import { execSpec, shQuote } from "./remote";

// gateway: backend discovery (CADDY_GEN_NETWORK=gateway), many stacks attached.
// edge:    isolated ingress only, avoids gateway DNS churn.
// IPv6 is dropped on purpose: internal ULA cost DNS and firewall work with no
// reachability gain, since Cloudflare terminates public v6 at the edge.
function netSetupScript(): string {
  const gw = process.env.GW_SUBNET ?? "172.16.0.0/16";
  const edge = process.env.EDGE_SUBNET ?? "172.30.0.0/16";
  return [
    `docker network inspect gateway >/dev/null 2>&1 \\`,
    `  || docker network create --driver bridge --subnet ${gw} --label project=gateway gateway`,
    `docker network inspect edge >/dev/null 2>&1 \\`,
    `  || docker network create --driver bridge --subnet ${edge} --label project=edge edge`,
    `docker network ls --filter 'name=^gateway$' --filter 'name=^edge$'`,
  ].join("\n");
}

export async function setup(hosts: string[]) {
  if (hosts.length === 0) throw new InventoryError("no hosts selected");
  let bad = 0;
  for (const name of hosts) {
    const target = sshTarget(name);
    const script = netSetupScript();
    console.log(`=== ${name} (${target}) ===`);
    const r = await $`${execSpec(name, `sh -c ${shQuote(script)}`)}`.nothrow();
    if (r.exitCode === 0) console.log(`ok: ${name}`);
    else {
      console.error(`FAIL: ${name}`);
      bad = 1;
    }
  }
  if (bad) process.exit(1);
}
