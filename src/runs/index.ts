// Public API for the Runs module.
//
// Construction is via `createRunExecutor(deps)` where `deps` is injected
// (Threads, the Runs store, Catalog, ModelGateway, Secrets). The server
// boot wires the deps together; tests construct with stubs.
//
// Stale-Run recovery (`markStaleAsFailed`) is exposed so the server can
// call it once at boot — any Run row left `running` from a previous
// process is flipped to `failed(daemon_restart)`. The Run executor itself
// only ever produces `running` rows it eventually finalizes.

export { createRunExecutor } from "./executor.ts";
export type { CreateRunExecutorDeps, RunExecutor, StartRunInput } from "./executor.ts";
export { createRunsStore } from "./store.ts";
export type { RunsStore } from "./store.ts";
export { MODEL_FALLBACK } from "./defaults.ts";
export type { Run, RunEvent, RunModuleEvents, RunStatus } from "./types.ts";
