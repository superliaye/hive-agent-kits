import { afterEach, describe, expect, test } from "bun:test";
import { Stream } from "effect";
import type { Agent, Catalog, CatalogEvents } from "../../catalog/index.ts";
import { type HiveDb, openHiveDb } from "../../db/hive-db.ts";
import { AgentId } from "../../lib/ids.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import type { Threads } from "../../threads/index.ts";
import { createThreadsStore } from "../../threads/store.ts";
import type { BackendAdapters } from "../backends/dispatch.ts";
import type { BackendInvocation } from "../backends/invocation.ts";
import type { BackendRun } from "../backends/port.ts";
import { createRunExecutor, type RunExecutor } from "../executor.ts";
import { createRunsStore } from "../store.ts";
import type { RunEvent } from "../types.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Omit<Agent, "agentId">> & { agentId?: string } = {}): Agent {
  const { agentId, ...rest } = overrides;
  return {
    agentId: AgentId.parse(agentId ?? "test-agent"),
    backend: "claude-code",
    domain: "Test",
    bindings: { skills: [], snippets: [], tools: [], mcp: [] },
    config: {},
    promptBody: "",
    layer: "bundled",
    hasFork: false,
    path: "/test/fake-path/HARNESS.md",
    ...rest,
  };
}

function makeCatalogStub(agents: Agent[]): Catalog {
  const events = new TypedEmitter<CatalogEvents>();
  return {
    list: () => agents,
    get: (id) => agents.find((a) => a.agentId === id),
    createAgent: async () => {
      throw new Error("not supported in stub");
    },
    destroyAgent: async () => {
      throw new Error("not supported in stub");
    },
    updateBindings: async () => {
      throw new Error("not supported in stub");
    },
    resetToBundled: async () => {
      throw new Error("not supported in stub");
    },
    start: async () => {},
    rescan: async () => {},
    events,
    dispose: () => {},
  };
}

// A fake BackendRun that yields a scripted RunEvent sequence. Captures the
// invocation it received (to assert resolution + callbacks). The lifecycle
// `run.completed`/`run.failed` is emitted by the adapter (the real seam).
function makeFakeAdapter(
  script: (inv: BackendInvocation) => RunEvent[],
  captured?: { inv?: BackendInvocation },
): BackendRun {
  return {
    run(inv: BackendInvocation) {
      if (captured) captured.inv = inv;
      return Stream.fromIterable(script(inv)) as ReturnType<BackendRun["run"]>;
    },
  };
}

function completedFor(inv: BackendInvocation, text = "ok"): RunEvent {
  return {
    type: "run.completed",
    runId: inv.runId,
    finishReason: "stop",
    finalMessage: {
      id: crypto.randomUUID(),
      threadId: inv.threadId,
      idx: 0,
      role: "assistant",
      content: [{ type: "text", text }],
      createdAt: 1,
    },
    ts: 1,
  };
}

type Harness = {
  runs: RunExecutor;
  threads: Threads;
  db: HiveDb;
  captured: { inv?: BackendInvocation };
};

function makeHarness(opts: {
  agents?: Agent[];
  adapter?: (inv: BackendInvocation) => RunEvent[];
}): Harness {
  const db = openHiveDb(":memory:");
  const threads = createThreadsStore(db);
  const runsStore = createRunsStore(db);
  const catalog = makeCatalogStub(opts.agents ?? [makeAgent()]);
  const captured: { inv?: BackendInvocation } = {};
  const adapter = makeFakeAdapter(opts.adapter ?? ((inv) => [completedFor(inv)]), captured);
  const adapters: BackendAdapters = { "claude-code": adapter, codex: adapter };
  const runs = createRunExecutor({
    threads,
    runs: runsStore,
    catalog,
    secrets: { getAuth: async () => undefined },
    adapters,
    mcpEndpoint: "http://127.0.0.1:3117/mcp",
    now: () => 1,
  });
  return { runs, threads, db, captured };
}

async function drain(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

const dbs: HiveDb[] = [];
afterEach(() => {
  dbs.splice(0);
});

function thread(threads: Threads, agentId = "test-agent"): string {
  const t = threads.create({ agentId: AgentId.parse(agentId) });
  return t.id;
}

// ─── tests ────────────────────────────────────────────────────────────────

describe("RunExecutor — happy path", () => {
  test("emits run.started then the adapter's events, finalizing run.completed", async () => {
    const h = makeHarness({
      agents: [makeAgent()],
      adapter: (inv) => [
        {
          type: "model.event",
          runId: inv.runId,
          event: { type: "text_delta", blockIndex: 0, delta: "hi" },
        },
        completedFor(inv, "hello"),
      ],
    });
    dbs.push(h.db);
    const tid = thread(h.threads);
    const events = await drain(
      h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "yo" }] }),
    );
    expect(events.map((e) => e.type)).toEqual(["run.started", "model.event", "run.completed"]);
    const run = h.runs.getRun((events[0] as { runId: string }).runId);
    expect(run?.status).toBe("completed");
    // The final assistant message is appended to Thread history.
    const msgs = h.threads.getCompletionMessages(tid);
    expect(msgs.at(-1)?.role).toBe("assistant");
  });

  test("dispatches to the resolved backend with a built invocation", async () => {
    const h = makeHarness({ agents: [makeAgent({ backend: "codex" })] });
    dbs.push(h.db);
    const tid = thread(h.threads);
    await drain(h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "x" }] }));
    expect(h.captured.inv?.backend).toBe("codex");
    expect(h.captured.inv?.mcpEndpoint).toBe("http://127.0.0.1:3117/mcp");
    expect(h.captured.inv?.mode).toEqual({ kind: "create" });
  });
});

describe("RunExecutor — failure paths", () => {
  test("agent_not_found when the agent is missing", async () => {
    const h = makeHarness({ agents: [] });
    dbs.push(h.db);
    // A thread referencing a non-existent agent.
    const tid = thread(h.threads, "ghost");
    const events = await drain(
      h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "x" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed") as
      | { error: { code: string } }
      | undefined;
    expect(failed?.error.code).toBe("agent_not_found");
  });

  test("forwards the adapter's run.failed and records it", async () => {
    const h = makeHarness({
      agents: [makeAgent()],
      adapter: (inv) => [
        {
          type: "run.failed",
          runId: inv.runId,
          error: { code: "auth_failed", message: "no" },
          ts: 1,
        },
      ],
    });
    dbs.push(h.db);
    const tid = thread(h.threads);
    const events = await drain(
      h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "x" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed") as
      | { runId: string; error: { code: string } }
      | undefined;
    expect(failed?.error.code).toBe("auth_failed");
    expect(h.runs.getRun(failed?.runId ?? "")?.status).toBe("failed");
  });
});

describe("RunExecutor — concurrency + status", () => {
  test("a second startRun on a busy thread throws synchronously", async () => {
    const h = makeHarness({ agents: [makeAgent()] });
    dbs.push(h.db);
    const tid = thread(h.threads);
    const first = h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "x" }] });
    expect(() =>
      h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "y" }] }),
    ).toThrow(/already in flight/);
    await drain(first);
    expect(h.runs.isThreadBusy(tid)).toBe(false);
  });

  test("newestTerminalRun reports the last finalized run", async () => {
    const h = makeHarness({ agents: [makeAgent()] });
    dbs.push(h.db);
    const tid = thread(h.threads);
    await drain(h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "x" }] }));
    expect(h.runs.newestTerminalRun(tid)?.status).toBe("completed");
  });
});

describe("RunExecutor — session resume", () => {
  test("a stored CLI session for the resolved backend resumes; persistSession records it", async () => {
    const h = makeHarness({
      agents: [makeAgent()],
      adapter: (inv) => {
        // The create turn persists a session id via the executor's callback.
        inv.callbacks.persistSession("sess-1");
        return [completedFor(inv)];
      },
    });
    dbs.push(h.db);
    const tid = thread(h.threads);
    await drain(h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "x" }] }));
    // Second turn resumes the stored session.
    await drain(h.runs.startRun({ threadId: tid, userMessage: [{ type: "text", text: "y" }] }));
    expect(h.captured.inv?.mode).toEqual({ kind: "resume", sessionId: "sess-1" });
  });
});
