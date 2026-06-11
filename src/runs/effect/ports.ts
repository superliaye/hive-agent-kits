// Narrow, consumer-owned ports for the Run executor (AGENTS.md "narrow,
// consumer-owned ports shaped to the consumer's need"). Each port exposes
// ONLY the verbs the executor actually calls — not the full module surface —
// so the executor type-depends on these shapes, never on ModelGateway /
// Catalog / Secrets / Threads / RunsStore concretes.
//
// They are also Context.Service tags so a future Effect-native root can
// provide them via Layer; this increment wires them as plain values through
// the legacy `createRunExecutor` proxy (coexistence).

import { Context, type Stream } from "effect";
import type { Agent } from "../../catalog/types.ts";
import type { GatewayFailure } from "../../model-gateway/effect/failure.ts";
import type {
  AuthInput,
  CompletionInput,
  ContentBlock,
  GatewayEvent,
  Message,
  ThinkingEffort,
} from "../../model-gateway/types.ts";
import type { ThreadMessage } from "../../threads/types.ts";
import type { CompleteRunInput, CreateRunInput, FailRunInput } from "../store.ts";
import type { Run } from "../types.ts";

// Completion: the typed gateway Stream, not the full ModelGateway. A thrown
// adapter/resolve failure is a GatewayFailure in the Stream's `E` channel.
export type CompletionPort = {
  completeStream(input: CompletionInput): Stream.Stream<GatewayEvent, GatewayFailure>;
};
export class Completion extends Context.Service<Completion, CompletionPort>()("runs/Completion") {}

// Secrets: provider → AuthInput only. Async because `getAuth` awaits the
// audited `secret.read` emit (block-on-failure on reads, 4.2-A1).
export type SecretsPort = {
  getAuth(provider: string): Promise<AuthInput | undefined>;
};
export class SecretsResolver extends Context.Service<SecretsResolver, SecretsPort>()(
  "runs/SecretsResolver",
) {}

// Catalog: agent lookup only.
export type CatalogPort = {
  get(agentId: string): Agent | undefined;
};
export class AgentLookup extends Context.Service<AgentLookup, CatalogPort>()("runs/AgentLookup") {}

// Agent preferences: the user's per-agent model + effort defaults, read-only.
// Synchronous (no audit on reads — the resolved model/effort are recorded by
// `run.started`), so they slot into the executor's sync resolution.
export type AgentModelPrefsPort = {
  getModel(agentId: string): string | undefined;
  getEffort(agentId: string): ThinkingEffort | undefined;
};
export class AgentModelPrefsLookup extends Context.Service<
  AgentModelPrefsLookup,
  AgentModelPrefsPort
>()("runs/AgentModelPrefsLookup") {}

// Threads: the three verbs the executor uses.
export type ThreadsPort = {
  get(threadId: string): { agentId: string } | undefined;
  append(input: {
    threadId: string;
    role: "user" | "assistant";
    content: ContentBlock[];
  }): ThreadMessage;
  getCompletionMessages(threadId: string): Message[];
};
export class ThreadHistory extends Context.Service<ThreadHistory, ThreadsPort>()(
  "runs/ThreadHistory",
) {}

// Cap config: the single value the tool-loop reads — snapshot once per Run.
// A narrow port over Config (not the whole Config tree). `maxIterations` is the
// turn cap; `0` = unlimited (no cap, no grace).
export type CapConfigPort = {
  maxIterations(): number;
};
export class CapConfig extends Context.Service<CapConfig, CapConfigPort>()("runs/CapConfig") {}

// Permission gate at the tool-dispatch point (ADR-0003 G2). The full G2
// Permission System is unbuilt; the executor satisfies this port itself today
// with a default impl (allowlist + destructive denylist). When G2 lands it
// provides this port. `decide` is async to leave room for an approval prompt.
export type PermissionDecision = { outcome: "allow" | "deny"; reason?: string };
export type PermissionPort = {
  decide(input: {
    agentId: string;
    runId: string;
    tool: string;
    command?: string;
  }): Promise<PermissionDecision>;
};
export class Permission extends Context.Service<Permission, PermissionPort>()("runs/Permission") {}

// Shell runner: the single I/O edge the run_shell Tool spawns through. Plain
// async (AGENTS.md "plain async only at I/O edges"). Injectable so tests stub
// it; the default impl uses node:child_process.
export type ShellResult = { stdout: string; stderr: string; exitCode: number };
export type ShellRunnerPort = {
  run(input: {
    command: string;
    args: string[];
    cwd: string;
    signal?: AbortSignal;
  }): Promise<ShellResult>;
};
export class ShellRunner extends Context.Service<ShellRunner, ShellRunnerPort>()(
  "runs/ShellRunner",
) {}

// Filesystem runner: the single I/O edge the file tools (read/write/edit) go
// through. Sibling of ShellRunnerPort — plain async at the true external
// boundary (node:fs), injectable so tests stub it. Returns typed results; the
// handlers fold them into ToolResults. Path safety (workspace confinement) is
// enforced in the handlers BEFORE these verbs are called, not here.
export type FsRunnerPort = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
};
export class FsRunner extends Context.Service<FsRunner, FsRunnerPort>()("runs/FsRunner") {}

// Skill resolver: the narrow, consumer-owned port `load_skill` + the Run-start
// progressive-disclosure listing read. Shaped to the runs consumer — it never
// imports capabilities concretes. The composition root adapts the F2
// BindingResolver to this shape and discharges its Effect to a plain value.
//
// `list(boundNames)` returns the resolvable bound skills' one-line listings
// (name + description) for the Run-start injection. `load(boundNames, name)`
// returns the body of `name` ONLY when it is in `boundNames` — scoping skill
// loads to the Agent's spawn-time bindings (CONTEXT.md: bindings are frozen
// into the Harness). An unbound or unresolvable name returns undefined; the
// handler turns that into an `isError` tool_result (never a throw).
export type SkillListing = { name: string; description: string };
export type SkillResolverPort = {
  list(boundNames: readonly string[]): SkillListing[];
  load(
    boundNames: readonly string[],
    name: string,
  ): { description: string; body: string } | undefined;
};
export class SkillResolver extends Context.Service<SkillResolver, SkillResolverPort>()(
  "runs/SkillResolver",
) {}

// Runs store: the lifecycle verbs the executor records through.
export type RunsStorePort = {
  create(input: CreateRunInput): Run;
  complete(input: CompleteRunInput): void;
  fail(input: FailRunInput): void;
  cancel(runId: string): void;
  get(runId: string): Run | undefined;
  listByThread(threadId: string): Run[];
};
export class RunLifecycle extends Context.Service<RunLifecycle, RunsStorePort>()(
  "runs/RunLifecycle",
) {}
