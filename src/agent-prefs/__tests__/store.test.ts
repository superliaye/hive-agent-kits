import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPrefsPersistence } from "../persistence.ts";
import { createAgentPrefsStore } from "../store.ts";
import { AGENT_PREFS_FILE_VERSION, type AgentPrefEvents } from "../types.ts";

const EMPTY = { version: AGENT_PREFS_FILE_VERSION, prefs: {} } as const;

describe("agent-prefs store", () => {
  test("get/set/list round-trip (model)", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    expect(store.getModel("agent-manager")).toBeUndefined();
    await store.set("agent-manager", { model: "anthropic/claude-opus-4-7" });
    expect(store.getModel("agent-manager")).toBe("anthropic/claude-opus-4-7");
    await store.set("root", { model: "openai-codex/gpt-5.2" });
    expect(store.list().map((p) => p.agentId)).toEqual(["agent-manager", "root"]);
  });

  test("set replaces an existing model pref", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await store.set("a", { model: "anthropic/claude-haiku-4-5" });
    await store.set("a", { model: "anthropic/claude-opus-4-7" });
    expect(store.getModel("a")).toBe("anthropic/claude-opus-4-7");
    expect(store.list()).toHaveLength(1);
  });

  test("model and effort are independent — setting one preserves the other", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await store.set("a", { model: "anthropic/claude-opus-4-7" });
    await store.set("a", { effort: "high" });
    // The effort write must NOT clobber the prior model, and vice versa.
    expect(store.getModel("a")).toBe("anthropic/claude-opus-4-7");
    expect(store.getEffort("a")).toBe("high");

    // Re-setting effort leaves the model untouched.
    await store.set("a", { effort: "low" });
    expect(store.getModel("a")).toBe("anthropic/claude-opus-4-7");
    expect(store.getEffort("a")).toBe("low");

    // Re-setting model leaves the effort untouched.
    await store.set("a", { model: "anthropic/claude-haiku-4-5" });
    expect(store.getModel("a")).toBe("anthropic/claude-haiku-4-5");
    expect(store.getEffort("a")).toBe("low");

    // One stored entry for the agent regardless of the number of writes.
    expect(store.list()).toHaveLength(1);
  });

  test("a combined patch sets both fields at once", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await store.set("a", { model: "anthropic/claude-opus-4-7", effort: "xhigh" });
    expect(store.getModel("a")).toBe("anthropic/claude-opus-4-7");
    expect(store.getEffort("a")).toBe("xhigh");
  });

  test("emits agent_pref.set with only the touched fields", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    const seen: AgentPrefEvents["agent_pref.set"][] = [];
    store.events.on("agent_pref.set", (e) => {
      seen.push(e);
    });
    await store.set("agent-manager", { model: "anthropic/claude-opus-4-7" });
    await store.set("agent-manager", { effort: "high" });
    expect(seen).toEqual([
      { agentId: "agent-manager", model: "anthropic/claude-opus-4-7" },
      { agentId: "agent-manager", effort: "high" },
    ]);
  });

  test("backend round-trips as an id and is independent of model/effort (OQ-2)", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await store.set("worker", { model: "anthropic/claude-opus-4-7" });
    await store.set("worker", { backend: "claude-code" });
    expect(store.getBackend("worker")).toBe("claude-code");
    // The backend write must NOT clobber the prior model.
    expect(store.getModel("worker")).toBe("anthropic/claude-opus-4-7");
    expect(store.list()).toHaveLength(1);
  });

  test("emits agent_pref.set carrying the backend axis when touched (OQ-2)", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    const seen: AgentPrefEvents["agent_pref.set"][] = [];
    store.events.on("agent_pref.set", (e) => {
      seen.push(e);
    });
    await store.set("worker", { backend: "codex" });
    expect(seen).toEqual([{ agentId: "worker", backend: "codex" }]);
  });

  test("backend: null clears the stored default (no audit value)", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await store.set("worker", { backend: "codex" });
    const seen: AgentPrefEvents["agent_pref.set"][] = [];
    store.events.on("agent_pref.set", (e) => {
      seen.push(e);
    });
    await store.set("worker", { backend: null });
    expect(store.getBackend("worker")).toBeUndefined();
    // A clear is a touched axis with no value — not surfaced in the payload.
    expect(seen).toEqual([{ agentId: "worker" }]);
  });

  test("rejects an invalid backend id before mutating", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    // @ts-expect-error — "ollama" is not an AgentBackend; the Zod parse rejects it.
    await expect(store.set("a", { backend: "ollama" })).rejects.toThrow();
    expect(store.getBackend("a")).toBeUndefined();
  });

  test("rejects a malformed model string before mutating", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await expect(store.set("a", { model: "no-slash" })).rejects.toThrow();
    expect(store.getModel("a")).toBeUndefined();
  });

  test("rejects an invalid effort level before mutating", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    // @ts-expect-error — "ultra" is not a ThinkingEffort; the Zod parse rejects it.
    await expect(store.set("a", { effort: "ultra" })).rejects.toThrow();
    expect(store.getEffort("a")).toBeUndefined();
  });

  test("rejects an empty patch (caller bug)", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await expect(store.set("a", {})).rejects.toThrow();
  });

  test("persists model + effort to disk and reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-prefs-"));
    const path = join(dir, "agent-model-prefs.json");
    try {
      const persist = new AgentPrefsPersistence(path);
      const store = createAgentPrefsStore(persist.read(), persist);
      await store.set("agent-manager", { model: "anthropic/claude-opus-4-7" });
      await store.set("agent-manager", { effort: "medium" });
      expect(existsSync(path)).toBe(true);

      const reloaded = createAgentPrefsStore(new AgentPrefsPersistence(path).read());
      expect(reloaded.getModel("agent-manager")).toBe("anthropic/claude-opus-4-7");
      expect(reloaded.getEffort("agent-manager")).toBe("medium");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
