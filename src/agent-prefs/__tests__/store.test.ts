import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPrefsPersistence } from "../persistence.ts";
import { createAgentPrefsStore } from "../store.ts";
import { AGENT_PREFS_FILE_VERSION, type AgentPrefEvents } from "../types.ts";

const EMPTY = { version: AGENT_PREFS_FILE_VERSION, prefs: {} } as const;

describe("agent-prefs store", () => {
  test("get/set/list round-trip", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    expect(store.get("agent-manager")).toBeUndefined();
    await store.set("agent-manager", "anthropic/claude-opus-4-7");
    expect(store.get("agent-manager")).toBe("anthropic/claude-opus-4-7");
    await store.set("root", "openai-codex/gpt-5.2");
    expect(store.list().map((p) => p.agentId)).toEqual(["agent-manager", "root"]);
  });

  test("set replaces an existing pref", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await store.set("a", "anthropic/claude-haiku-4-5");
    await store.set("a", "anthropic/claude-opus-4-7");
    expect(store.get("a")).toBe("anthropic/claude-opus-4-7");
    expect(store.list()).toHaveLength(1);
  });

  test("emits agent_model_pref.set on write", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    const seen: AgentPrefEvents["agent_model_pref.set"][] = [];
    store.events.on("agent_model_pref.set", (e) => {
      seen.push(e);
    });
    await store.set("agent-manager", "anthropic/claude-opus-4-7");
    expect(seen).toEqual([{ agentId: "agent-manager", model: "anthropic/claude-opus-4-7" }]);
  });

  test("rejects a malformed model string before mutating", async () => {
    const store = createAgentPrefsStore({ ...EMPTY });
    await expect(store.set("a", "no-slash")).rejects.toThrow();
    expect(store.get("a")).toBeUndefined();
  });

  test("persists to disk and reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-prefs-"));
    const path = join(dir, "agent-model-prefs.json");
    try {
      const persist = new AgentPrefsPersistence(path);
      const store = createAgentPrefsStore(persist.read(), persist);
      await store.set("agent-manager", "anthropic/claude-opus-4-7");
      expect(existsSync(path)).toBe(true);

      const reloaded = createAgentPrefsStore(new AgentPrefsPersistence(path).read());
      expect(reloaded.get("agent-manager")).toBe("anthropic/claude-opus-4-7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
