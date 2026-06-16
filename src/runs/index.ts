// Public API for the Runs module.
//
// Construction is via `createRunExecutor(deps)` where `deps` is injected
// (Threads, the Runs store, Catalog, Secrets, the two SDK backend adapters).
// The server boot wires the deps together; tests construct with stubs.
//
// Stale-Run recovery (`markStaleAsFailed`) is exposed so the server can call it
// once at boot — any Run row left `running` from a previous process is flipped to
// `failed(daemon_restart)`.

export {
  type AgentLifecyclePort,
  type CapabilityInvokePort,
  type CapabilityMcpHandle,
  createCapabilityMcpServer,
} from "./backends/capabilities-mcp.ts";
export { createClaudeAdapter } from "./backends/claude/adapter.ts";
export { createCodexAdapter } from "./backends/codex/adapter.ts";
export type { BackendAdapters } from "./backends/dispatch.ts";
export { dispatch } from "./backends/dispatch.ts";
export type { BackendInvocation, InvocationSkill } from "./backends/invocation.ts";
export type { BackendRun } from "./backends/port.ts";
export { MODEL_FALLBACK } from "./defaults.ts";
export type {
  FsCopyPort,
  ProjectableSkill,
  RunnableCatalogPort,
  SkillProjectionPort,
} from "./effect/ports.ts";
export type { CreateRunExecutorDeps, RunExecutor, StartRunInput } from "./executor.ts";
export { createRunExecutor } from "./executor.ts";
export type { AvailableModel, RunnableCatalog } from "./model-catalog.ts";
export {
  listModelsForProvider,
  PROVIDER_PREFERENCE,
  parseModelProvider,
  runnableCatalog,
} from "./model-catalog.ts";
export type { ResolveInput, ResolveResult } from "./resolve.ts";
export { resolve } from "./resolve.ts";
export type { ResolveAgentModelInput, ResolveAgentModelResult } from "./resolve-model.ts";
export { resolveAgentModel } from "./resolve-model.ts";
export type { RunsStore } from "./store.ts";
export { createRunsStore } from "./store.ts";
export type { BackendEvents, Run, RunEvent, RunModuleEvents, RunStatus } from "./types.ts";
