// In-memory store + event emitter for the agent model-preferences module.
//
// Holds the per-agent model-default map; persistence (file mode) is injected
// and called after every mutation. Mirrors the Secrets store shape.

import { TypedEmitter } from "../lib/typed-emitter.ts";
import type { AgentPrefsPersistence } from "./persistence.ts";
import {
  AGENT_PREFS_FILE_VERSION,
  type AgentModelPref,
  type AgentPrefEvents,
  type AgentPrefsFile,
  type ConfiguredAgentModelPref,
  ModelStringSchema,
} from "./types.ts";

export type AgentPrefsStore = {
  /**
   * The user's chosen model for an agent, or undefined. Pure synchronous read
   * with NO audit emit — model-pref reads happen on every Run resolution, and
   * the resolved model is already recorded by `run.started`. Keeping it sync
   * lets the executor's hot path stay sync.
   */
  get(agentId: string): string | undefined;

  /**
   * Set (create/replace) an agent's model default. Emits `agent_model_pref.set`.
   * Persists in file mode. Audit-first: the emit is awaited BEFORE the map/disk
   * mutation (ADR-0004). Rejects a malformed model string before any side
   * effect.
   */
  set(agentId: string, model: string): Promise<void>;

  /** List every stored preference, stable order by agentId. */
  list(): ConfiguredAgentModelPref[];

  /** Snapshot of the underlying map (round-trip tests / migrations). */
  snapshot(): AgentPrefsFile;

  events: TypedEmitter<AgentPrefEvents>;
};

export function createAgentPrefsStore(
  initial: AgentPrefsFile,
  persist?: AgentPrefsPersistence,
  now: () => number = Date.now,
): AgentPrefsStore {
  const map = new Map<string, AgentModelPref>(Object.entries(initial.prefs));
  const events = new TypedEmitter<AgentPrefEvents>();

  function snapshot(): AgentPrefsFile {
    return { version: AGENT_PREFS_FILE_VERSION, prefs: Object.fromEntries(map) };
  }

  return {
    events,

    get(agentId) {
      return map.get(agentId)?.model;
    },

    async set(agentId, model) {
      // Reject malformed before any emit/mutation, so a bad value can never
      // land in memory or on disk.
      ModelStringSchema.parse(model);
      await events.emit("agent_model_pref.set", { agentId, model });
      map.set(agentId, { model, updatedAt: now() });
      if (persist) persist.write(snapshot());
    },

    list() {
      const out: ConfiguredAgentModelPref[] = [];
      for (const [agentId, pref] of map) {
        out.push({ agentId, model: pref.model, updatedAt: pref.updatedAt });
      }
      out.sort((a, b) => a.agentId.localeCompare(b.agentId));
      return out;
    },

    snapshot,
  };
}
