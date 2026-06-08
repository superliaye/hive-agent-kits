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
