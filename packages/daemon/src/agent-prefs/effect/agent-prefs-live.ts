// Effect-native agent preferences module (mirrors SecretsLive, ADR-0011).
//
// `AgentModelPrefs` is the Context.Service tag; `AgentModelPrefsLive(opts)` a
// layer owning the in-memory store (reading persistence at build in file mode).
// `set` is async + audit-first (ADR-0004 4.2-A1); `getModel`/`getEffort` are
// pure synchronous reads. The store + sync persistence own no long-lived
// handle, so release is a no-op — `Layer.effect` over `acquireRelease` keeps
// the pattern uniform with the other Lives so the root runtime owns teardown.

import { Context, Effect, Layer } from "effect";
import type { TypedEmitter } from "../../lib/typed-emitter.ts";
import { AgentPrefsPersistence } from "../persistence.ts";
import { type AgentPrefsStore, createAgentPrefsStore } from "../store.ts";
import {
  AGENT_PREFS_FILE_VERSION,
  type AgentPrefEvents,
  type AgentPrefPatch,
  type AgentPrefsFile,
  type Backend,
  type ConfiguredAgentPref,
  type Effort,
} from "../types.ts";

export type CreateAgentPrefsOptions =
  | { mode: "memory"; initial?: AgentPrefsFile }
  | { mode: "file"; path: string };

export type AgentModelPrefsSvc = {
  getModel(agentId: string): string | undefined;
  getEffort(agentId: string): Effort | undefined;
  getBackend(agentId: string): Backend | undefined;
  set(agentId: string, patch: AgentPrefPatch): Promise<void>;
  list(): ConfiguredAgentPref[];
  events: TypedEmitter<AgentPrefEvents>;
};

export class AgentModelPrefs extends Context.Service<AgentModelPrefs, AgentModelPrefsSvc>()(
  "agent-prefs/AgentModelPrefs",
) {}

function openStore(opts: CreateAgentPrefsOptions): AgentPrefsStore {
  if (opts.mode === "memory") {
    return createAgentPrefsStore(opts.initial ?? { version: AGENT_PREFS_FILE_VERSION, prefs: {} });
  }
  const persist = new AgentPrefsPersistence(opts.path);
  return createAgentPrefsStore(persist.read(), persist);
}

function buildSvc(store: AgentPrefsStore): AgentModelPrefsSvc {
  return {
    events: store.events,
    getModel: (agentId) => store.getModel(agentId),
    getEffort: (agentId) => store.getEffort(agentId),
    getBackend: (agentId) => store.getBackend(agentId),
    set: (agentId, patch) => store.set(agentId, patch),
    list: () => store.list(),
  };
}

export function AgentModelPrefsLive(opts: CreateAgentPrefsOptions): Layer.Layer<AgentModelPrefs> {
  return Layer.effect(
    AgentModelPrefs,
    Effect.acquireRelease(
      Effect.sync(() => buildSvc(openStore(opts))),
      () => Effect.void,
    ),
  );
}
