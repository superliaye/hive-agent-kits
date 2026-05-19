import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent, Catalog } from "../../catalog/index.ts";
import { type HiveDb, openHiveDb } from "../../db/hive-db.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { makeFakeAdapter } from "../../model-gateway/adapters/fake.ts";
import { type ModelGateway, createGateway } from "../../model-gateway/index.ts";
import type { GatewayEvent } from "../../model-gateway/types.ts";
import { type Secrets, createSecrets } from "../../secrets/index.ts";
import type { Threads } from "../../threads/index.ts";
import { createThreadsStore } from "../../threads/store.ts";
import { type RunExecutor, createRunExecutor } from "../executor.ts";
import { createRunsStore } from "../store.ts";
import type { RunEvent } from "../types.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "test-agent",
    backend: "native",
    domain: "Test",
    bindings: { skills: [], snippets: [], tools: [], mcp: [] },
    config: {},
    promptBody: "",
    layer: "bundled",
    hasFork: false,
    path: "/test/fake-path/HARNESS.md",
    ...overrides,
  };
}

function makeCatalogStub(agents: Agent[]): Catalog {
  const events = new TypedEmitter<{
    "agent.created": never;
    "agent.destroyed": never;
    "harness.updated": never;
  }>();
  return {
    list: () => agents,
    get: (id) => agents.find((a) => a.agentId === id),
    updateBindings: async () => {
      throw new Error("not supported in stub");
    },
    resetToBundled: async () => {
      throw new Error("not supported in stub");
    },
    start: async () => {},
    rescan: async () => {},
    // biome-ignore lint/suspicious/noExplicitAny: stub event emitter has different generic; the executor doesn't read events on catalog.
    events: events as any,
    dispose: () => {},
  };
}

function makeFakeGateway(fixtures: Record<string, GatewayEvent[]>): ModelGateway {
  const gw = createGateway();
  // Register the fake adapter as the canonical anthropic provider so the
  // executor's "provider extraction → secrets.getAuth" path works.
  gw.registerAdapter(makeFakeAdapter(["anthropic"], fixtures));
  return gw;
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// ─── test harness ───────────────────────────────────────────────────────────

type Harness = {
  db: HiveDb;
  threads: Threads;
  secrets: Secrets;
  executor: RunExecutor;
  threadId: string;
};

function setup(opts: {
  fixtures: Record<string, GatewayEvent[]>;
  agents?: Agent[];
  withApiKey?: boolean;
  agentId?: string;
}): Harness {
  const db = openHiveDb(":memory:");
  const threadsStore = createThreadsStore(db);
  const runsStore = createRunsStore(db);
  const secrets = createSecrets({ mode: "memory" });
  if (opts.withApiKey ?? true) secrets.setApiKey("anthropic", "sk-test");
  const agents = opts.agents ?? [makeAgent({ agentId: opts.agentId ?? "test-agent" })];
  const catalog = makeCatalogStub(agents);
  const gateway = makeFakeGateway(opts.fixtures);
  const executor = createRunExecutor({
    threads: threadsStore,
    runs: runsStore,
    catalog,
    gateway,
    secrets,
  });
  const threadId = threadsStore.create({ agentId: opts.agentId ?? "test-agent" }).id;
  return { db, threads: threadsStore, secrets, executor, threadId };
}

// ─── happy path ─────────────────────────────────────────────────────────────

describe("RunExecutor — happy path", () => {
  test("text-only Run emits started, model events, completed; persists assistant message", async () => {
    const { threads, executor, threadId } = setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "text_start", blockIndex: 0 },
          { type: "text_delta", blockIndex: 0, delta: "hello " },
          { type: "text_delta", blockIndex: 0, delta: "world" },
          { type: "text_end", blockIndex: 0 },
          { type: "usage", inputTokens: 5, outputTokens: 2 },
          { type: "done", finishReason: "stop" },
        ],
      },
    });
    const events = await collect(
      executor.startRun({
        threadId,
        userMessage: [{ type: "text", text: "hi" }],
      }),
    );

    // Lifecycle: started, ...model events..., completed
    expect(events[0]?.type).toBe("run.started");
    expect(events[events.length - 1]?.type).toBe("run.completed");

    // The user + assistant messages both landed.
    const msgs = threads.listMessages(threadId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.content).toEqual([{ type: "text", text: "hello world" }]);

    // Run row reflects completed status.
    const completedEvent = events[events.length - 1];
    if (completedEvent?.type === "run.completed") {
      const r = executor.getRun(completedEvent.runId);
      expect(r?.status).toBe("completed");
      expect(r?.finishReason).toBe("stop");
    }
  });

  test("tool_use turn stops at done(tool_use); tool_use block lands in assistant message", async () => {
    const { threads, executor, threadId } = setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "tool_use_start", blockIndex: 0, id: "tu_1", name: "search" },
          { type: "tool_use_end", blockIndex: 0, id: "tu_1", args: { q: "x" } },
          { type: "done", finishReason: "tool_use" },
        ],
      },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "search x" }] }),
    );
    const completed = events[events.length - 1];
    expect(completed?.type).toBe("run.completed");
    if (completed?.type === "run.completed") {
      expect(completed.finishReason).toBe("tool_use");
    }
    const assistant = threads.listMessages(threadId).find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
    ]);
  });

  test("emits model.event for every GatewayEvent", async () => {
    const { executor, threadId } = setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "text_start", blockIndex: 0 },
          { type: "text_delta", blockIndex: 0, delta: "x" },
          { type: "text_end", blockIndex: 0 },
          { type: "done", finishReason: "stop" },
        ],
      },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const modelEventCount = events.filter((e) => e.type === "model.event").length;
    expect(modelEventCount).toBe(4); // text_start, text_delta, text_end, done
  });
});

// ─── failure paths ──────────────────────────────────────────────────────────

describe("RunExecutor — failure paths", () => {
  test("missing agent → run.failed(agent_not_found), no messages appended", async () => {
    const { threads, executor, threadId } = setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
      agents: [], // catalog empty
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "run.failed") {
      expect(failed.error.code).toBe("agent_not_found");
    }
    // No user message appended (pre-flight failure).
    expect(threads.listMessages(threadId)).toHaveLength(0);
  });

  test("missing secret → run.failed(no_credentials)", async () => {
    const { executor, threadId } = setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
      withApiKey: false,
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "run.failed") {
      expect(failed.error.code).toBe("no_credentials");
    }
  });

  test("gateway emits error → run.failed with the classified code", async () => {
    const { executor, threadId } = setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "error", code: "rate_limited", message: "429", retryable: true },
          { type: "done", finishReason: "error" },
        ],
      },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "run.failed") {
      expect(failed.error.code).toBe("rate_limited");
      expect(failed.error.message).toBe("429");
    }
  });

  test("missing thread → startRun throws (caller bug, not a Run failure)", async () => {
    const { executor } = setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
    });
    await expect(
      collect(
        executor.startRun({ threadId: "missing", userMessage: [{ type: "text", text: "hi" }] }),
      ),
    ).rejects.toThrow(/thread not found/);
  });
});

// ─── model resolution ──────────────────────────────────────────────────────

describe("RunExecutor — model resolution", () => {
  test("modelOverride wins over harness config", async () => {
    const { executor, threadId } = setup({
      fixtures: {
        "anthropic/claude-opus-4-7": [{ type: "done", finishReason: "stop" }],
      },
      agents: [makeAgent({ config: { model: "anthropic/claude-haiku-4-5" } })],
    });
    const events = await collect(
      executor.startRun({
        threadId,
        userMessage: [{ type: "text", text: "hi" }],
        modelOverride: "anthropic/claude-opus-4-7",
      }),
    );
    const started = events[0];
    if (started?.type === "run.started") {
      expect(started.model).toBe("anthropic/claude-opus-4-7");
    }
  });

  test("falls back to MODEL_FALLBACK when harness config has no model", async () => {
    const { executor, threadId } = setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
      agents: [makeAgent({ config: {} })],
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const started = events[0];
    if (started?.type === "run.started") {
      expect(started.model).toBe("anthropic/claude-haiku-4-5");
    }
  });
});

// ─── concurrency + cancellation ─────────────────────────────────────────────

describe("RunExecutor — concurrency + cancellation", () => {
  test("concurrent startRun on same Thread throws", async () => {
    const { executor, threadId } = setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": (() => {
          // Long-ish script so first run is still going when second is attempted
          const evs: GatewayEvent[] = [];
          for (let i = 0; i < 200; i++) {
            evs.push({ type: "text_delta", blockIndex: 0, delta: "x" });
          }
          evs.push({ type: "done", finishReason: "stop" });
          return evs;
        })(),
      },
    });

    // Start one run but don't consume it yet — its initial steps run inside
    // the async iterator. Begin consuming, then start a second concurrent
    // run on the same thread; expect throw.
    const firstIter = executor.startRun({
      threadId,
      userMessage: [{ type: "text", text: "go" }],
    });
    const it = firstIter[Symbol.asyncIterator]();
    // Pull one event so the executor enters its run loop and marks the thread busy.
    await it.next();
    // Now try a second concurrent run — should throw synchronously when the
    // generator function checks the busy-thread guard.
    expect(() => {
      const second = executor.startRun({
        threadId,
        userMessage: [{ type: "text", text: "again" }],
      });
      // Force generator body to run via a sync iteration call — but the
      // body is async, so the throw will surface as a rejected promise.
      // The `expect` in this test pattern uses `.toThrow` only for sync;
      // wrap in an async assert.
      void second;
    }).not.toThrow();
    // Actual assertion: collecting the second iterator rejects.
    const second = executor.startRun({
      threadId,
      userMessage: [{ type: "text", text: "again" }],
    });
    await expect(collect(second)).rejects.toThrow(/already in flight/);
    // Drain the first.
    while (true) {
      const { done } = await it.next();
      if (done) break;
    }
  });
});
