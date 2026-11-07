// Execution helpers shared by every remote-touching module.
import { isLocal, sshTarget } from "./inv";

// One shell script string per server action: the REMOTE shell interprets it over
// ssh, and `sh -c` runs it identically for a `localhost`-targeted server.
export function execSpec(name: string, script: string): string[] {
  return isLocal(name)
    ? ["sh", "-c", script]
    : ["ssh", "-o", "BatchMode=yes", sshTarget(name), script];
}

// -p pins the project: stdin compose otherwise derives it from the remote
// cwd, lumping every streamed service into one project (orphan warnings).
export function composeRemote(svc: string, verbs: string): string {
  return `docker compose -f - -p '${svc}' ${verbs}`;
}

export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Sets `$c` to the one running container of compose project `svc`, by label so
// no compose file is needed. An empty `key` takes the project's only running
// service and fails when it runs more than one.
export function containerLookup(svc: string, key: string): string {
  const label = `label=com.docker.compose.project=${svc}`;
  if (key) {
    return (
      `c=$(docker ps -q --filter '${label}'` +
      ` --filter 'label=com.docker.compose.service=${key}' | head -n1)\n` +
      `if [ -z "$c" ]; then echo ${shQuote(`fleet: no running container for ${svc}:${key}`)} >&2; exit 1; fi`
    );
  }
  return (
    `svcs=$(docker ps --format '{{.Label "com.docker.compose.service"}}'` +
    ` --filter '${label}' | sort -u | paste -sd, -)\n` +
    `if [ -z "$svcs" ]; then echo ${shQuote(`fleet: no running container for ${svc}`)} >&2; exit 1; fi\n` +
    `if [ "$svcs" != "\${svcs#*,}" ]; then` +
    ` echo ${shQuote(`fleet: ${svc} has multiple services — pass a service key`)} >&2; exit 1; fi\n` +
    `c=$(docker ps -q --filter '${label}'` +
    ` --filter "label=com.docker.compose.service=$svcs" | head -n1)`
  );
}
