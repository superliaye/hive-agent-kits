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

export { MODEL_FALLBACK } from "./defaults.ts";
export type { CreateRunExecutorDeps, RunExecutor, StartRunInput } from "./executor.ts";
export { createRunExecutor } from "./executor.ts";
export type { ResolveInput, ResolveResult } from "./resolve.ts";
export { resolve } from "./resolve.ts";
export type { ResolveAgentModelInput, ResolveAgentModelResult } from "./resolve-model.ts";
export { resolveAgentModel } from "./resolve-model.ts";
export type { RunsStore } from "./store.ts";
export { createRunsStore } from "./store.ts";
export type { Run, RunEvent, RunModuleEvents, RunStatus } from "./types.ts";
