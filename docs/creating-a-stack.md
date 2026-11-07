# Creating a stack — guide for agents

A **stack** (a _setup_) is the checkout that consumes the `fleet` engine.
This repo holds no setup: yours lives elsewhere and points at the engine.
Nothing in a setup is published with the engine.

## Layout

```
<setup>/
  fleet.yaml            servers + shared env defaults
  fleet.local.yaml       gitignored per-box overrides
  fnox.toml              vault entries (encrypted, never printed)
  _envs/                 encrypted env files (restic creds, etc.)
  _tmp/                  rendered previews (gitignored, disposable)
  <svc>/
    service.yaml         manifest
    compose.yml.tmpl     the Compose file
    prepare.ts           optional render hook
    generated-envs.json  committed derived values (optional)
  justfile               wires the setup to the engine (optional)
```

`ROOT` (the setup) is resolved from `FLEET_ROOT` or the nearest `fleet.yaml`
walking up from PWD. `SCRIPTS` is the engine checkout: `fleet/paths.ts` resolves
it from `import.meta.dir`, so it works both in the checkout and installed.
The two are independent.

## The inventory: `fleet.yaml`

```yaml
servers:
  box1: user@box1.example.com
  box2: user@box2.example.com
env:
  default:
    FLEET_DEFAULT_KEY: shared-value
    FLEET_HOST: ignored # reserved: the renderer injects it
```

Rules:

- `servers` maps a name to an ssh target (transport only, no secrets).
- A target of `localhost` means "this machine": commands run directly, no ssh.
- `env.default` is visible to every template and every service.
- `fleet.local.yaml` merges over `fleet.yaml` key by key at every level.
  Use it for per-box connection details without touching the committed file.

## The manifest: `<svc>/service.yaml`

```yaml
volumes: # OPTIONAL: external volumes the service expects
  <vol-name>: #   LITERAL name — must match the tmpl's external volume
    writable: false #   true when the app itself writes what we push
    files: #   OPTIONAL: target path in the volume -> repo template
      <path/in/vol>: <repo-relative-template>
    backup: #   OPTIONAL: what `volume restic-backup` snapshots
      sqlite: [] #   live dbs → online .backup copy
      file: [] #   read as-is; a path or a whole directory
servers: # OPTIONAL deploy scope; absent = all servers
  - box1
backup: # OPTIONAL: backups that are not volume files
  dumps: #   logical dumps of a live db, run in the service's container
    - name: postgres # → /<svc>/dumps/<name>.sql in the snapshot
      cmd: [pg_dumpall, -U, postgres]
      service: db # OPTIONAL compose service, when the project runs >1
env:
  default: { KEY: value } # visible to compose.yml.tmpl + all templates
  <host>: { KEY: value } # per-server override (host wins)
```

- Precedence: `fleet default < fleet <host> < service default < service <host>`.
  `$NAME` references resolve after the merge.
- `volumes` with a file map are pushed config. Pushed files get `444`;
  `writable: true` gives `666` on the files and `777` on the directories above.
- `setup-volumes` creates declared volumes and seeds them only when empty.
  `push-volumes` overwrites config explicitly. Never rename a live volume —
  the compose key is its identity (`<project>_<key>`).

## The Compose template: `compose.yml.tmpl`

- Env comes from the manifest: `{{ .Env.KEY }}`. gomplate fails hard on
  missing keys, so every `.Env.X` needs an `env` entry (or a fleet-level one).
- Secrets go inline via the plugin, single-quoted: `KEY: '{{ secret "NAME" }}'`.
  `FLEET_HOST` is always available (per-host secret names derive from it).
- No `container_name` — deploys pin the project with `-p <svc>`.
- Gateway network:

```yaml
networks:
  default:
    name: gateway
    external: true
```

- Ingress through caddy labels: `virtual.bind: <port> <host> [modifiers]`.
- Prefer `snake_case` for new volumes (`myservice_data`); kebab is for
  service and network names.

## The hook: `<svc>/prepare.ts`

```ts
import { define, readSecret, type ServiceHook, type Kind } from "fleet";

const rows = [
  { key: "HASH", kind: "derive", secret: "MY_HASH_SECRET" },
  { key: "REGION", kind: "region", env: "MY_REGION" },
] as const;

const kinds: Record<string, Kind> = {
  derive: {
    derive: (input) => Bun.hash(input).toString(),
    verify: (input, value) => value === Bun.hash(input).toString(),
  },
};

const hook: ServiceHook = {
  default: define(rows, kinds),
  // optional, runs once per render before the table:
  prepare: async () => {
    /* generate other artifacts */
  },
  // optional, runs per host after that host's files exist:
  validate: async (ctx) => {
    const { dockerValidate } = await import("fleet");
    await dockerValidate({ image: "myservice:latest", cmd: ["check"], mounts: [], env: {} });
  },
};

export default hook.default;
```

- A row is `{ key, kind, secret | env }` — exactly one of `secret`/`env`.
  `env` inputs must live in a `default:` block: the table runs once per render,
  so a derived value cannot vary by host.
- The committed artifact is `<svc>/generated-envs.json`, merged into `.Env`
  _below_ every declared value, so a manifest always wins.
- `fleet prepare <svc>` writes the file when absent, verifies it when present,
  and only rewrites with `--force`. A failure aborts the render naming the key,
  never the value. `down` skips prepare.
- A kind must be able to `verify` a committed value against its input.
  For randomised transforms, verify by inverting (decrypt and compare).
- `validate(ctx)` gets `{ host, root, env, dirFor(vol) }` with the rendered
  compose in `ctx.root` and a staged volume tree from `ctx.dirFor(vol)`.
  `dockerValidate` runs the service's own image — never a different build,
  which would reject config the box serves. It warns and returns without Docker.

## Secrets and the vault

- Templates never touch the vault directly. The renderer runs
  `FLEET_SECRET_PLUGIN` (default: `secret.sh`, backed by fnox) as
  `<plugin> <name>` and uses stdout as the value. Any executable with that
  contract works.
- Every secret name carries its owning service as a prefix — no bare
  cross-service names. The restic credentials in `_envs/fleet-backup.env.enc`
  and any shared `S3_*` pair are the only by-design exceptions.
- Restic credentials live in an encrypted env file (`_envs/fleet-backup.env.enc`
  by default), unlocked by `FLEET_ENCRYPTION_KEY` from the vault.
- `secret list` prints vault entries with their projects; `secret check`
  prints only the drift (`missing` / `unused` / `per-host`) and exits non-zero.
  Only keys are read, never values.

## Adding a service — recipe

1. `mkdir <svc>`, write `compose.yml.tmpl` (rules above).
2. Write `service.yaml`: pick `servers:` explicitly for anything stateful or
   single-box, set `env.default`, add per-host blocks only for differences.
3. If a secret is needed, add it to the vault first (human side).
4. `bunx fleet render <svc>` — the unrendered-marker and YAML-parse
   gates catch template mistakes here.
5. `bunx fleet setup-volumes <svc>` if it has volumes, then
   `bunx fleet up <svc>`.
6. Verify on the box. Wire the deploy through your entry point (`just fleet`
   or `bunx fleet` via `FLEET_ROOT`).
7. Commit `<svc>/`; wipe previews with `rm -rf _tmp` or your clean recipe.

## Driving the engine

- `just fleet <command> …` (or `FLEET_ROOT=. bunx fleet <command>`)
  is the single entry. `--help` on the program or any command is the reference.
- Host args are optional everywhere; absent = inventory scope, or the
  service's own scope for a service verb. Service verbs take the service first.
- `exec`, `volume run` and `env` hand their tail to another command after `--`.
- After `push-volumes`, follow with `up --force-recreate`. `restart` is the plain bounce.
- Bundle `onbox/cli.ts` with `bun build --target=bun` into a single file for the
  service volume; the shared helpers live in `shared/`. Scripts that still run
  from source get a `bun install` + `exec` wrapper in the service (its own
  hard-coded `package.json` in the volume, deps installed at run time).

## Safety

- Never print secret material: no rendered compose, no `_tmp/**`, no vault reads
  for values, no direct gomplate invocations — run the CLI instead.
- Scripts are Bun/TypeScript, not bash (macOS ships bash 3.2).
- Typecheck with `bun x tsc --noEmit` in both the setup and the engine checkout.
- A service `prepare.ts` in a subfolder may only import from inside the repo
  root or the `fleet` package; the engine resolves the setup root by walking
  up from PWD, so run commands from the setup root or set `FLEET_ROOT`.
