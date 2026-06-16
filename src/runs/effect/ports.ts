// Narrow, consumer-owned ports for the Run executor (AGENTS.md "narrow,
// consumer-owned ports shaped to the consumer's need"). Each port exposes ONLY
// the verbs the executor actually calls — not the full module surface — so the
// executor type-depends on these shapes, never on Catalog / Secrets / Threads /
// RunsStore concretes.
//
// With the native loop deleted (ADR-0019), the native-path ports are gone
// (Completion, ShellRunner, FsRunner, Permission, CapConfig, SkillResolver,
// CliSpawner). The surviving ports below feed the SDK-backend dispatch.

import { Context } from "effect";
import type { Agent } from "../../catalog/types.ts";
import type { AuthInput } from "../../lib/auth.ts";
import type { AgentBackend, Origin } from "../../lib/capability-types.ts";
import type { ThinkingEffort } from "../../lib/effort.ts";
import type { AgentId } from "../../lib/ids.ts";
import type { ContentBlock, Message } from "../../lib/messages.ts";
import type { ThreadMessage } from "../../threads/types.ts";
import type { RunnableCatalog } from "../model-catalog.ts";
import type { CompleteRunInput, CreateRunInput, FailRunInput } from "../store.ts";
import type { Run } from "../types.ts";

// Secrets: provider → AuthInput only. Async because `getAuth` awaits the audited
// `secret.read` emit (block-on-failure on reads, 4.2-A1).
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

// Runnable model catalog: the credentialed ∩ routable models, newest-first. The
// symbolic resolver consumes this to turn a "latest"/"highest" default into a
// concrete provider/model + effort. Snapshot once per Run.
export type RunnableCatalogPort = {
  snapshot(): RunnableCatalog;
};
export class RunnableCatalogLookup extends Context.Service<
  RunnableCatalogLookup,
  RunnableCatalogPort
>()("runs/RunnableCatalogLookup") {}

// Agent preferences: the user's per-agent model + effort + backend defaults.
export type AgentModelPrefsPort = {
  getModel(agentId: string): string | undefined;
  getEffort(agentId: string): ThinkingEffort | "highest" | undefined;
  getBackend(agentId: string): AgentBackend | undefined;
};
export class AgentModelPrefsLookup extends Context.Service<
  AgentModelPrefsLookup,
  AgentModelPrefsPort
>()("runs/AgentModelPrefsLookup") {}

// Threads: the verbs the executor uses. `getCliSession`/`setCliSession` carry the
// SDK native-session token (ADR-0016) for resume across Runs.
export type ThreadsPort = {
  get(threadId: string):
    | {
        agentId: AgentId;
        modelPref?: string | null;
        effortPref?: string | null;
        workingDir?: string | null;
        backend?: string | null;
      }
    | undefined;
  append(input: {
    threadId: string;
    role: "user" | "assistant";
    content: ContentBlock[];
  }): ThreadMessage;
  getCompletionMessages(threadId: string): Message[];
  /** Read the Thread's stored SDK native-session token (ADR-0016), if any. */
  getCliSession(threadId: string): { backend: string; sessionId: string } | undefined;
  /** Persist the Thread's SDK native-session token after a successful create. */
  setCliSession(threadId: string, session: { backend: string; sessionId: string }): void;
};
export class ThreadHistory extends Context.Service<ThreadHistory, ThreadsPort>()(
  "runs/ThreadHistory",
) {}

// Skill projection: resolves bound skill names to projectable {name, path,
// origin}. The composition root adapts the BindingResolver to this shape and
// discharges its Effect to a plain value; runs/ never imports capabilities
// concretes. Misses are simply absent from the array.
export type ProjectableSkill = { name: string; path: string; origin: Origin };
export type SkillProjectionPort = {
  resolve(boundNames: readonly string[]): ProjectableSkill[];
};
export class SkillProjection extends Context.Service<SkillProjection, SkillProjectionPort>()(
  "runs/SkillProjection",
) {}

// FS copy: the single I/O edge the skill projector copies skill DIRECTORIES
// through (recursive dir copy + best-effort recursive remove for cleanup). Plain
// async at the true external boundary (node:fs/promises).
export type FsCopyPort = {
  copy(src: string, dest: string): Promise<void>;
  remove(target: string): Promise<void>;
};
export class FsCopy extends Context.Service<FsCopy, FsCopyPort>()("runs/FsCopy") {}

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
