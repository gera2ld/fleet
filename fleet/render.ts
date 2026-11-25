// Rendering: gomplate templates -> per-host previews under _tmp/.
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SECRET_PLUGIN,
  TMP_DIR,
  InventoryError,
  envFor,
  hostsFor,
  normalizePort,
  publicPorts,
  serviceDir,
  volumeFiles,
} from "./inv";
import { loadService, runService } from "./prepare";

async function renderFile(tmplPath: string, destPath: string, svc: string, host: string) {
  // FLEET_HOST is the renderer's own per-host assertion, spread last so a
  // manifest cannot forge it (templates derive per-host secret names).
  const text = await $`gomplate -f ${tmplPath} --plugin secret=${SECRET_PLUGIN}`
    .env({ ...process.env, ...envFor(svc, host), FLEET_HOST: host })
    .text();
  if (text.includes("{{")) {
    throw new InventoryError(`${tmplPath}: unrendered template marker in output`);
  }
  // Compose files must be valid YAML; the raw parser error carries no path.
  if (destPath.endsWith("compose.yml")) {
    try {
      parseYaml(text);
    } catch (e) {
      throw new InventoryError(`${destPath}: invalid YAML: ${e instanceof Error ? e.message : e}`);
    }
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await Bun.write(destPath, text);
}

// One published port of a compose service, as the gate sees it: the host IP it
// binds (empty = every interface) and the host-side port, normalized.
type Published = { ip: string; port: string | undefined; raw: string };

function parsePort(entry: unknown): Published {
  if (typeof entry === "object" && entry !== null) {
    // Long syntax: {target, published, host_ip, protocol}.
    const e = entry as Record<string, unknown>;
    const proto = String(e.protocol ?? "tcp");
    const pub = e.published === undefined ? "" : String(e.published);
    return {
      ip: String(e.host_ip ?? ""),
      port: pub ? normalizePort(`${pub}/${proto}`) : undefined,
      raw: JSON.stringify(entry),
    };
  }
  const raw = String(entry);
  let rest = raw;
  let proto = "tcp";
  const slash = rest.lastIndexOf("/");
  if (slash >= 0) {
    proto = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
  }
  let ip = "";
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    ip = rest.slice(1, close);
    rest = rest.slice(close + 2);
  }
  const parts = rest.split(":");
  let pub = "";
  if (parts.length === 2) pub = parts[0] ?? "";
  else if (parts.length >= 3) {
    ip = ip || parts.slice(0, -2).join(":");
    pub = parts[parts.length - 2] ?? "";
  }
  // One part = container port only: docker picks a random host port.
  return { ip, port: pub ? normalizePort(`${pub}/${proto}`) : undefined, raw };
}

const ALL_INTERFACES = new Set(["", "0.0.0.0", "::"]);

// Docker DNATs a published port ahead of the host firewall, so a port bound to
// every interface is reachable from anywhere no matter what ufw says. Such a
// port must be declared in `public_ports` (which the firewall unit opens), or
// bound to an address (MESH_IP, 127.0.0.1).
function checkPublishedPorts(svc: string, host: string, compose: unknown) {
  const declared = new Set(publicPorts(svc));
  const services = (compose as { services?: Record<string, { ports?: unknown[] }> })?.services;
  for (const [name, spec] of Object.entries(services ?? {})) {
    for (const entry of spec?.ports ?? []) {
      const p = parsePort(entry);
      if (!ALL_INTERFACES.has(p.ip)) continue;
      if (!p.port) {
        throw new InventoryError(
          `${svc} (${host}): service '${name}' publishes '${p.raw}' on a random port on every interface — give it a host IP and port`,
        );
      }
      if (!declared.has(p.port)) {
        throw new InventoryError(
          `${svc} (${host}): service '${name}' publishes ${p.port} on every interface — bind it to an IP (MESH_IP, 127.0.0.1) or list '${p.port}' under public_ports in ${svc}/service.yaml`,
        );
      }
    }
  }
}

// Preview per-host files into _tmp/<host>/<svc>/; nothing is pushed. teardown
// skips the render hooks, so `down` still works when the derived env no longer
// validates.
export async function render(
  svc: string,
  hosts: string[],
  opts: { teardown?: boolean } = {},
): Promise<string[]> {
  const names = hostsFor(svc, hosts);
  if (names.length === 0) throw new InventoryError("no hosts selected");
  const teardown = opts.teardown === true;
  const hook = teardown ? undefined : await loadService(svc);
  if (hook) await runService(svc, hook);
  const files = volumeFiles(svc);
  for (const name of names) {
    const out = join(TMP_DIR, name, svc);
    await renderFile(join(serviceDir(svc), "compose.yml.tmpl"), join(out, "compose.yml"), svc, name);
    checkPublishedPorts(svc, name, parseYaml(await Bun.file(join(out, "compose.yml")).text()));
    let rendered = 0;
    for (const f of files) {
      const dest = join(out, f.vol, f.target);
      if (join(serviceDir(svc), f.tmpl).endsWith(".tmpl")) {
        await renderFile(join(serviceDir(svc), f.tmpl), dest, svc, name);
        rendered++;
      } else {
        // Opaque source (ciphertext, images, plain config with no actions):
        // gomplate is text-based and the `{{` check below would false-positive
        // on random bytes, so byte-copy instead of rendering.
        mkdirSync(dirname(dest), { recursive: true });
        await Bun.write(dest, Bun.file(join(serviceDir(svc), f.tmpl)));
      }
      if (f.target.endsWith(".json")) {
        try {
          JSON.parse(await Bun.file(dest).text());
        } catch (e) {
          throw new InventoryError(`${dest}: invalid JSON: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (hook?.validate) {
      await hook.validate({
        host: name,
        root: out,
        env: envFor(svc, name),
        dirFor: (vol) => {
          const dir = join(out, vol);
          if (!existsSync(dir)) {
            throw new InventoryError(`${svc}: no rendered volume '${vol}' for ${name}`);
          }
          return dir;
        },
      });
      console.log(`validated ${svc} on ${name}`);
    }
    console.log(
      `rendered _tmp/${name}/${svc}/compose.yml + ${rendered} template(s), ${files.length - rendered} raw file(s)`,
    );
  }
  return names;
}
