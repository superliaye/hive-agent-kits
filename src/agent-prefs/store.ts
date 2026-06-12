// In-memory store + event emitter for the agent preferences module.
//
// Holds the per-agent model + effort defaults; persistence (file mode) is
// injected and called after every mutation. Mirrors the Secrets store shape.

import { TypedEmitter } from "../lib/typed-emitter.ts";
import type { AgentPrefsPersistence } from "./persistence.ts";
import {
  AGENT_PREFS_FILE_VERSION,
  type AgentPref,
  type AgentPrefEvents,
  type AgentPrefPatch,
  type AgentPrefsFile,
  type Backend,
  BackendSchema,
  type ConfiguredAgentPref,
  type Effort,
  EffortSchema,
  ModelStringSchema,
} from "./types.ts";

export type AgentPrefsStore = {
  /**
   * The user's chosen model for an agent, or undefined. Pure synchronous read
   * with NO audit emit — pref reads happen on every Run resolution, and the
   * resolved model/effort are already recorded by `run.started`. Keeping it
   * sync lets the executor's hot path stay sync.
   */
  getModel(agentId: string): string | undefined;

  /** The user's chosen thinking effort for an agent, or undefined. Sync read. */
  getEffort(agentId: string): Effort | undefined;

  /** The user's chosen Agent Backend for an agent, or undefined. Sync read. */
  getBackend(agentId: string): Backend | undefined;

  /**
   * Merge a model/effort patch into an agent's preference. Omitting a field
   * leaves the stored value unchanged (never clobbers the other). Emits
   * `agent_pref.set` carrying the touched fields. Persists in file mode.
   * Audit-first: the emit is awaited BEFORE the map/disk mutation (ADR-0004).
   * Rejects a malformed model string or effort level before any side effect.
   * A no-op patch (neither field present) is rejected as a caller bug.
   */
  set(agentId: string, patch: AgentPrefPatch): Promise<void>;

  /** List every stored preference, stable order by agentId. */
  list(): ConfiguredAgentPref[];

  /** Snapshot of the underlying map (round-trip tests / migrations). */
  snapshot(): AgentPrefsFile;

  events: TypedEmitter<AgentPrefEvents>;
};

export function createAgentPrefsStore(
  initial: AgentPrefsFile,
  persist?: AgentPrefsPersistence,
  now: () => number = Date.now,
): AgentPrefsStore {
  const map = new Map<string, AgentPref>(Object.entries(initial.prefs));
  const events = new TypedEmitter<AgentPrefEvents>();

  function snapshot(): AgentPrefsFile {
    return { version: AGENT_PREFS_FILE_VERSION, prefs: Object.fromEntries(map) };
  }

  return {
    events,

    getModel(agentId) {
      return map.get(agentId)?.model;
    },

    getEffort(agentId) {
      return map.get(agentId)?.effort;
    },

    getBackend(agentId) {
      return map.get(agentId)?.backend;
    },

    async set(agentId, patch) {
      // Reject malformed/empty before any emit/mutation, so a bad value can
      // never land in memory or on disk. `backend: null` is a CLEAR (valid).
      if (patch.model === undefined && patch.effort === undefined && patch.backend === undefined) {
        throw new Error("agent-prefs: set requires at least one of { model, effort, backend }");
      }
      if (patch.model !== undefined) ModelStringSchema.parse(patch.model);
      if (patch.effort !== undefined) EffortSchema.parse(patch.effort);
      if (patch.backend !== undefined && patch.backend !== null) BackendSchema.parse(patch.backend);

      // A non-null backend write carries the id; a clear (null) is a touched
      // axis with no value, so it is not surfaced in the audit payload (the
      // event keeps refs/values only for sets — same posture as a model write).
      const event: AgentPrefEvents["agent_pref.set"] = {
        agentId,
        ...(patch.model !== undefined && { model: patch.model }),
        ...(patch.effort !== undefined && { effort: patch.effort }),
        ...(patch.backend !== undefined && patch.backend !== null && { backend: patch.backend }),
      };
      await events.emit("agent_pref.set", event);

      // Merge: keep the prior value for any field the patch omits. `backend:
      // null` clears the stored default (drops the field).
      const prev = map.get(agentId);
      const next: AgentPref = {
        ...(patch.model !== undefined
          ? { model: patch.model }
          : prev?.model !== undefined
            ? { model: prev.model }
            : {}),
        ...(patch.effort !== undefined
          ? { effort: patch.effort }
          : prev?.effort !== undefined
            ? { effort: prev.effort }
            : {}),
        ...(patch.backend !== undefined
          ? patch.backend !== null
            ? { backend: patch.backend }
            : {}
          : prev?.backend !== undefined
            ? { backend: prev.backend }
            : {}),
        updatedAt: now(),
      };
      map.set(agentId, next);
      if (persist) persist.write(snapshot());
    },

    list() {
      const out: ConfiguredAgentPref[] = [];
      for (const [agentId, pref] of map) {
        out.push({
          agentId,
          ...(pref.model !== undefined && { model: pref.model }),
          ...(pref.effort !== undefined && { effort: pref.effort }),
          ...(pref.backend !== undefined && { backend: pref.backend }),
          updatedAt: pref.updatedAt,
        });
      }
      out.sort((a, b) => a.agentId.localeCompare(b.agentId));
      return out;
    },

    snapshot,
  };
}
