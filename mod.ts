// The stable surface for a setup's own hooks. Keep deep imports working, but
// prefer this module in prepare.ts files so the published API can evolve
// without chasing every internal file.
export {
  define,
  readSecret,
  dockerValidate,
  loadService,
  prepareService,
  runService,
} from "./fleet/prepare";
export type { Env, Kind, Row, Table, ValidateCtx, ValidateFn, ServiceHook } from "./fleet/prepare";
export { ROOT, SCRIPTS, TMP_DIR, ENV_DIR, SECRET_PLUGIN, CLI } from "./fleet/paths";
export { hostsFor, service, serviceNames, envFor } from "./fleet/inv";
