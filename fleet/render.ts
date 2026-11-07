// Rendering: gomplate templates -> per-host previews under _tmp/.
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ROOT, SECRET_PLUGIN, TMP_DIR, InventoryError, envFor, hostsFor, volumeFiles } from "./inv";
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
    await renderFile(join(ROOT, svc, "compose.yml.tmpl"), join(out, "compose.yml"), svc, name);
    let rendered = 0;
    for (const f of files) {
      const dest = join(out, f.vol, f.target);
      if (join(ROOT, svc, f.tmpl).endsWith(".tmpl")) {
        await renderFile(join(ROOT, svc, f.tmpl), dest, svc, name);
        rendered++;
      } else {
        // Opaque source (ciphertext, images, plain config with no actions):
        // gomplate is text-based and the `{{` check below would false-positive
        // on random bytes, so byte-copy instead of rendering.
        mkdirSync(dirname(dest), { recursive: true });
        await Bun.write(dest, Bun.file(join(ROOT, svc, f.tmpl)));
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
