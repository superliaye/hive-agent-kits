import { afterEach, describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import pino from "pino";
import type { Agent, Catalog, CatalogEvents } from "../../catalog/index.ts";
import { type HiveDb, openHiveDb } from "../../db/hive-db.ts";
import type { AgentBackend } from "../../lib/capability-types.ts";
import { setLogger, silentLogger } from "../../lib/log.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { makeFakeAdapter } from "../../model-gateway/adapters/fake.ts";
import { createGateway, type ModelGateway } from "../../model-gateway/index.ts";
import type { CompletionInput, GatewayEvent, ThinkingEffort } from "../../model-gateway/types.ts";
import {
  SecretsLive,
  type SecretsSvc,
  Secrets as SecretsTag,
} from "../../secrets/effect/secrets-live.ts";
import type { Threads } from "../../threads/index.ts";
import { createThreadsStore } from "../../threads/store.ts";
import { createRunExecutor, type RunExecutor } from "../executor.ts";
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
  // Typed to the Catalog's own event map — no casts. The executor doesn't read
  // catalog events, but a correctly-typed emitter satisfies the interface.
  const events = new TypedEmitter<CatalogEvents>();
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
    events,
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

// One ManagedRuntime per resolved Secrets service; disposed in afterEach.
const secretsRuntimes: Array<{ dispose(): Promise<void> }> = [];
function makeSecrets(): SecretsSvc {
  const runtime = ManagedRuntime.make(SecretsLive({ mode: "memory" }));
  secretsRuntimes.push(runtime);
  return runtime.runSync(SecretsTag);
}

afterEach(async () => {
  for (const rt of secretsRuntimes.splice(0)) await rt.dispose();
});

// ─── test harness ───────────────────────────────────────────────────────────

type Harness = {
  db: HiveDb;
  threads: Threads;
  secrets: SecretsSvc;
  executor: RunExecutor;
  threadId: string;
};

async function setup(opts: {
  fixtures: Record<string, GatewayEvent[]>;
  agents?: Agent[];
  withApiKey?: boolean;
  agentId?: string;
  prefs?: {
    getModel(agentId: string): string | undefined;
    getEffort(agentId: string): ThinkingEffort | undefined;
    getBackend(agentId: string): AgentBackend | undefined;
  };
}): Promise<Harness> {
  const db = openHiveDb(":memory:");
  const threadsStore = createThreadsStore(db);
  const runsStore = createRunsStore(db);
  const secrets = makeSecrets();
  if (opts.withApiKey ?? true) await secrets.setApiKey("anthropic", "sk-test");
  const agents = opts.agents ?? [makeAgent({ agentId: opts.agentId ?? "test-agent" })];
  const catalog = makeCatalogStub(agents);
  const gateway = makeFakeGateway(opts.fixtures);
  const executor = createRunExecutor({
    threads: threadsStore,
    runs: runsStore,
    catalog,
    gateway,
    secrets,
    ...(opts.prefs ? { prefs: opts.prefs } : {}),
  });
  const threadId = threadsStore.create({ agentId: opts.agentId ?? "test-agent" }).id;
  return { db, threads: threadsStore, secrets, executor, threadId };
}

// ─── happy path ─────────────────────────────────────────────────────────────

describe("RunExecutor — happy path", () => {
  test("text-only Run emits started, model events, completed; persists assistant message", async () => {
    const { threads, executor, threadId } = await setup({
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

  test("tool_use turn for an UNBOUND tool: not sent, model never asks (text turn finalizes)", async () => {
    // The test agent binds no tools, so `search` is never sent. A text-only
    // turn finalizes the Run. (Loop dispatch behavior lives in tool-loop.test.ts
    // with a bound run_shell + function-form fixture.)
    const { threads, executor, threadId } = await setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "text_start", blockIndex: 0 },
          { type: "text_delta", blockIndex: 0, delta: "no tools here" },
          { type: "text_end", blockIndex: 0 },
          { type: "done", finishReason: "stop" },
        ],
      },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "search x" }] }),
    );
    const completed = events[events.length - 1];
    expect(completed?.type).toBe("run.completed");
    const assistant = threads.listMessages(threadId).find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "no tools here" }]);
  });

  test("emits model.event for every GatewayEvent", async () => {
    const { executor, threadId } = await setup({
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

// ─── worker-only backend neutralization — TRACE warning at the call site ──────

describe("RunExecutor — backend neutralization emits a TRACE warning (P8)", () => {
  // Capture the trace logger's JSONL output into a buffer. `resolve()` stays
  // pure (asserted in resolve.test.ts); the warning is emitted at the executor's
  // I/O edge when the resolved backend was neutralized for a non-Worker agent.
  function captureLog(): { lines: () => string[] } {
    const chunks: string[] = [];
    const stream = { write: (s: string) => chunks.push(s) };
    setLogger(pino({ level: "warn" }, stream));
    return { lines: () => chunks };
  }

  afterEach(() => setLogger(silentLogger()));

  const textFixture = {
    "anthropic/claude-haiku-4-5": [
      { type: "text_start" as const, blockIndex: 0 },
      { type: "text_delta" as const, blockIndex: 0, delta: "ok" },
      { type: "text_end" as const, blockIndex: 0 },
      { type: "done" as const, finishReason: "stop" as const },
    ],
  };

  test("fires when a non-native backend is neutralized for a non-Worker agent", async () => {
    const cap = captureLog();
    // `root` is a non-Worker; its harness backend is non-native → neutralized.
    const { executor, threadId } = await setup({
      fixtures: textFixture,
      agentId: "root",
      agents: [makeAgent({ agentId: "root", backend: "claude-code" })],
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));

    const warning = cap
      .lines()
      .map((l) => JSON.parse(l))
      .find((o) => o.msg === "neutralized non-native backend for non-Worker agent");
    expect(warning).toBeDefined();
    expect(warning.agentId).toBe("root");
    expect(warning.backend).toBe("claude-code");
    expect(warning.module).toBe("runs/resolve");
  });

  test("reports the THREAD-scope offender, not the harness backend (P13/P14/P15)", async () => {
    const cap = captureLog();
    // `root` is a non-Worker whose harness backend is `native` (always allowed);
    // the non-native offender enters via the higher-precedence Thread pick. The
    // warning must carry `codex` (the value actually neutralized), NOT the
    // lowest-precedence `agent.backend === "native"` — which is impossible to
    // neutralize and would mislead the diagnostic.
    const { executor, threads, threadId } = await setup({
      fixtures: textFixture,
      agentId: "root",
      agents: [makeAgent({ agentId: "root", backend: "native" })],
    });
    await threads.setScope(threadId, { backend: "codex" });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));

    const warning = cap
      .lines()
      .map((l) => JSON.parse(l))
      .find((o) => o.msg === "neutralized non-native backend for non-Worker agent");
    expect(warning).toBeDefined();
    expect(warning.agentId).toBe("root");
    expect(warning.backend).toBe("codex");
  });

  test("does NOT fire when no backend is neutralized (native, allowed path)", async () => {
    const cap = captureLog();
    // A native-backend agent: nothing to neutralize → no warning. (A Worker
    // keeping a non-native backend would dispatch to the real CLI, out of scope
    // for this call-site assertion; the pure non-neutralization is pinned in
    // resolve.test.ts.)
    const { executor, threadId } = await setup({
      fixtures: textFixture,
      agentId: "worker-7",
      agents: [makeAgent({ agentId: "worker-7", backend: "native" })],
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));

    const warning = cap
      .lines()
      .map((l) => JSON.parse(l))
      .find((o) => o.msg === "neutralized non-native backend for non-Worker agent");
    expect(warning).toBeUndefined();
  });
});

// ─── failure paths ──────────────────────────────────────────────────────────

describe("RunExecutor — failure paths", () => {
  test("missing agent → run.failed(agent_not_found), no messages appended", async () => {
    const { threads, executor, threadId } = await setup({
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
    const { executor, threadId } = await setup({
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
    const { executor, threadId } = await setup({
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

  test("missing thread → startRun throws synchronously (caller bug, not a Run failure)", async () => {
    const { executor } = await setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
    });
    expect(() =>
      executor.startRun({ threadId: "missing", userMessage: [{ type: "text", text: "hi" }] }),
    ).toThrow(/thread not found/);
  });

  // ADR-0004 §Verification item 4 (no silent-degrade) — a failing audit
  // subscriber on run.started fails the originating Run op AND leaves no Run row
  // (audit-first: the emit precedes runs.create, so when it throws the create
  // never runs). Mirrors the A1 Secrets test.
  test("throwing run.started subscriber → drain rejects, no Run row committed", async () => {
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
    });
    executor.events.on("run.started", () => {
      throw new Error("audit persist failed");
    });
    await expect(
      collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] })),
    ).rejects.toThrow(/audit persist failed/);
    // Audit-first: the Run row was never created (the emit rejected before
    // runs.create), so no committed Run lacks its audit row.
    expect(executor.listByThread(threadId)).toHaveLength(0);
  });

  // ADR-0004 §Verification item 4 across the rest of the lifecycle (not just
  // the run.started entry transition). Each test pins the audit-first ordering
  // for one terminal emit: a throwing subscriber must reject the drain AND
  // leave the Run row un-mutated (still `running`) — proving the emit precedes
  // the runs.complete / runs.cancel / runs.fail mutation. A future refactor that
  // reverts to `void events.emit(...)` or moves the mutation before the emit on
  // any of these paths now fails a test.
  test("throwing run.completed subscriber → drain rejects, Run row stays running", async () => {
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
    });
    let capturedRunId: string | undefined;
    executor.events.on("run.completed", ({ runId }) => {
      capturedRunId = runId;
      throw new Error("audit persist failed");
    });
    await expect(
      collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] })),
    ).rejects.toThrow(/audit persist failed/);
    // Audit-first: the emit precedes runs.complete, so the row is still running.
    expect(capturedRunId).toBeDefined();
    if (capturedRunId) expect(executor.getRun(capturedRunId)?.status).toBe("running");
  });

  test("throwing run.cancelled subscriber → drain rejects, Run row stays running", async () => {
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "cancelled" }] },
    });
    let capturedRunId: string | undefined;
    executor.events.on("run.cancelled", ({ runId }) => {
      capturedRunId = runId;
      throw new Error("audit persist failed");
    });
    await expect(
      collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] })),
    ).rejects.toThrow(/audit persist failed/);
    // Audit-first: the emit precedes runs.cancel, so the row is still running.
    expect(capturedRunId).toBeDefined();
    if (capturedRunId) expect(executor.getRun(capturedRunId)?.status).toBe("running");
  });

  // run.failed differs: the gateway-error path runs runs.create BEFORE
  // finalizeFailed, so a Run row exists in `running` when the emit throws. Per the
  // plan's Tests §caveat that is the acceptable over-record (ADR-0004:172-174) —
  // this test asserts block-on-failure + that the row stays `running` (the emit
  // precedes runs.fail), NOT row-absence.
  test("throwing run.failed subscriber → drain rejects, Run row stays running (not failed)", async () => {
    const { executor, threadId } = await setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "error", code: "rate_limited", message: "429", retryable: true },
          { type: "done", finishReason: "error" },
        ],
      },
    });
    let capturedRunId: string | undefined;
    executor.events.on("run.failed", ({ runId }) => {
      capturedRunId = runId;
      throw new Error("audit persist failed");
    });
    await expect(
      collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] })),
    ).rejects.toThrow(/audit persist failed/);
    // Audit-first: the emit precedes runs.fail, so the over-recorded row is
    // still running (never transitioned to failed).
    expect(capturedRunId).toBeDefined();
    if (capturedRunId) expect(executor.getRun(capturedRunId)?.status).toBe("running");
  });
});

// ─── model resolution ──────────────────────────────────────────────────────

describe("RunExecutor — model resolution", () => {
  test("modelOverride wins over harness config", async () => {
    const { executor, threadId } = await setup({
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
    const { executor, threadId } = await setup({
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

  test("user per-agent default beats harness config.model", async () => {
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-opus-4-7": [{ type: "done", finishReason: "stop" }] },
      agents: [makeAgent({ config: { model: "anthropic/claude-haiku-4-5" } })],
      prefs: {
        getModel: () => "anthropic/claude-opus-4-7",
        getEffort: () => undefined,
        getBackend: () => undefined,
      },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const started = events[0];
    if (started?.type === "run.started") {
      expect(started.model).toBe("anthropic/claude-opus-4-7");
    }
  });

  test("modelOverride beats the user per-agent default", async () => {
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-opus-4-7": [{ type: "done", finishReason: "stop" }] },
      agents: [makeAgent({ config: { model: "anthropic/claude-haiku-4-5" } })],
      prefs: {
        getModel: () => "anthropic/claude-sonnet-4-6",
        getEffort: () => undefined,
        getBackend: () => undefined,
      },
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
});

// ─── effort resolution ───────────────────────────────────────────────────────

// An adapter that records the CompletionInput it was handed, so a test can
// assert which `thinking` (if any) the executor sent. Mirrors makeFakeGateway
// but captures input rather than scripting per-model fixtures.
function makeCapturingGateway(): {
  gateway: ModelGateway;
  last: () => CompletionInput | undefined;
} {
  let captured: CompletionInput | undefined;
  const gw = createGateway();
  gw.registerAdapter({
    providers: ["anthropic"],
    async *complete(input: CompletionInput): AsyncIterable<GatewayEvent> {
      captured = input;
      yield { type: "done", finishReason: "stop" };
    },
  });
  return { gateway: gw, last: () => captured };
}

async function runEffortCase(opts: {
  agentConfig?: Record<string, unknown>;
  prefs?: {
    getModel(agentId: string): string | undefined;
    getEffort(agentId: string): ThinkingEffort | undefined;
    getBackend(agentId: string): AgentBackend | undefined;
  };
  effortOverride?: ThinkingEffort;
}): Promise<CompletionInput | undefined> {
  const db = openHiveDb(":memory:");
  const threadsStore = createThreadsStore(db);
  const runsStore = createRunsStore(db);
  const secrets = makeSecrets();
  await secrets.setApiKey("anthropic", "sk-test");
  const catalog = makeCatalogStub([
    makeAgent({
      agentId: "test-agent",
      config: { model: "anthropic/claude-haiku-4-5", ...(opts.agentConfig ?? {}) },
    }),
  ]);
  const { gateway, last } = makeCapturingGateway();
  const executor = createRunExecutor({
    threads: threadsStore,
    runs: runsStore,
    catalog,
    gateway,
    secrets,
    ...(opts.prefs ? { prefs: opts.prefs } : {}),
  });
  const threadId = threadsStore.create({ agentId: "test-agent" }).id;
  await collect(
    executor.startRun({
      threadId,
      userMessage: [{ type: "text", text: "hi" }],
      ...(opts.effortOverride !== undefined && { effortOverride: opts.effortOverride }),
    }),
  );
  return last();
}

describe("RunExecutor — effort resolution", () => {
  test("no override / pref / harness config → no `thinking` sent (provider default)", async () => {
    const input = await runEffortCase({});
    expect(input?.thinking).toBeUndefined();
  });

  test("harness config.thinkingEffort is used when nothing earlier resolves", async () => {
    const input = await runEffortCase({ agentConfig: { thinkingEffort: "medium" } });
    expect(input?.thinking).toEqual({ effort: "medium" });
  });

  test("an unrecognized harness config.thinkingEffort is ignored (no thinking sent)", async () => {
    const input = await runEffortCase({ agentConfig: { thinkingEffort: "bogus" } });
    expect(input?.thinking).toBeUndefined();
  });

  test("user per-agent effort default beats harness config.thinkingEffort", async () => {
    const input = await runEffortCase({
      agentConfig: { thinkingEffort: "low" },
      prefs: { getModel: () => undefined, getEffort: () => "high", getBackend: () => undefined },
    });
    expect(input?.thinking).toEqual({ effort: "high" });
  });

  test("per-Run effortOverride beats the user per-agent default", async () => {
    const input = await runEffortCase({
      agentConfig: { thinkingEffort: "low" },
      prefs: { getModel: () => undefined, getEffort: () => "high", getBackend: () => undefined },
      effortOverride: "xhigh",
    });
    expect(input?.thinking).toEqual({ effort: "xhigh" });
  });

  test("effort 'off' resolves and is sent — distinct from unset (disable-capable models)", async () => {
    // For a model that can disable reasoning, "off" is a real, sent choice —
    // not the same as omitting `thinking` entirely (which lets the provider
    // pick its own default). This distinctness does NOT apply to the
    // can't-disable subset: the catalog drops "off" from those models'
    // `efforts` (thinkingLevelMap["off"] === null), so the composer never
    // offers it and this path isn't reached with "off" for them.
    const input = await runEffortCase({ effortOverride: "off" });
    expect(input?.thinking).toEqual({ effort: "off" });
  });
});

// ─── typed gateway failures (Phase 2 Item 4) ─────────────────────────────────

// Wire an executor with an explicit gateway + provider so we can exercise the
// typed `GatewayFailure` paths (thrown adapter, resolve miss) that the legacy
// out-of-band catch used to collapse to "unknown".
async function setupWithGateway(opts: {
  gateway: ModelGateway;
  provider: string;
  model: string;
}): Promise<{ executor: RunExecutor; threadId: string }> {
  const db = openHiveDb(":memory:");
  const threadsStore = createThreadsStore(db);
  const runsStore = createRunsStore(db);
  const secrets = makeSecrets();
  await secrets.setApiKey(opts.provider, "sk-test");
  const catalog = makeCatalogStub([
    makeAgent({ agentId: "test-agent", config: { model: opts.model } }),
  ]);
  const executor = createRunExecutor({
    threads: threadsStore,
    runs: runsStore,
    catalog,
    gateway: opts.gateway,
    secrets,
  });
  const threadId = threadsStore.create({ agentId: "test-agent" }).id;
  return { executor, threadId };
}

describe("RunExecutor — typed gateway failures", () => {
  test("adapter stream that THROWS mid-iteration → run.failed with the GatewayFailure code", async () => {
    const gw = createGateway();
    gw.registerAdapter({
      providers: ["anthropic"],
      complete() {
        let sent = false;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (!sent) {
                  sent = true;
                  return Promise.resolve({
                    value: { type: "text_start", blockIndex: 0 } satisfies GatewayEvent,
                    done: false,
                  });
                }
                return Promise.reject(new Error("kaboom"));
              },
            };
          },
        };
      },
    });
    const { executor, threadId } = await setupWithGateway({
      gateway: gw,
      provider: "anthropic",
      model: "anthropic/claude-haiku-4-5",
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "run.failed") {
      // A truly-unknown throw maps to "unknown" — but it is the typed
      // GatewayFailure.code, surfaced in-band, not the deleted catch's blanket.
      expect(failed.error.code).toBe("unknown");
      expect(failed.error.message).toContain("kaboom");
    }
    // The pre-failure model.event still made it through.
    expect(events.some((e) => e.type === "model.event")).toBe(true);
  });

  test("resolve miss (provider has a secret but no adapter) → run.failed(model_not_found), not unknown", async () => {
    const gw = createGateway();
    // Register an adapter for "anthropic" only; the run targets "vertex".
    gw.registerAdapter(
      makeFakeAdapter(["anthropic"], {
        "anthropic/x": [{ type: "done", finishReason: "stop" }],
      }),
    );
    const { executor, threadId } = await setupWithGateway({
      gateway: gw,
      provider: "vertex",
      model: "vertex/gemini",
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "run.failed") {
      expect(failed.error.code).toBe("model_not_found");
    }
  });

  test("symbolic 'latest' with no runnable catalog → run.failed carries the resolver's model_not_found code+message verbatim (P1), not a hardcoded malformed-model invalid_request", async () => {
    // Agent's harness config.model is the symbolic "latest" (the E3 root case);
    // no runnableCatalog is wired (empty snapshot ⇒ nothing to resolve to). The
    // resolver returns a typed model_not_found; the executor must thread it
    // through verbatim rather than relabeling it "invalid_request / malformed".
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
      agents: [makeAgent({ agentId: "test-agent", config: { model: "latest" } })],
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "run.failed") {
      expect(failed.error.code).toBe("model_not_found");
      expect(failed.error.message).toContain("no credentialed, routable provider is configured");
      expect(failed.error.message).not.toContain("malformed model");
    }
  });
});

// ─── concurrency + cancellation ─────────────────────────────────────────────

describe("RunExecutor — concurrency + cancellation", () => {
  test("concurrent startRun on same Thread throws synchronously", async () => {
    const { executor, threadId } = await setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": (() => {
          const evs: GatewayEvent[] = [];
          for (let i = 0; i < 200; i++) {
            evs.push({ type: "text_delta", blockIndex: 0, delta: "x" });
          }
          evs.push({ type: "done", finishReason: "stop" });
          return evs;
        })(),
      },
    });

    // First run — busy-thread set is populated synchronously by startRun,
    // even before the iterator is advanced.
    const firstIter = executor.startRun({
      threadId,
      userMessage: [{ type: "text", text: "go" }],
    });
    // Second concurrent run on the same thread now throws synchronously.
    expect(() =>
      executor.startRun({
        threadId,
        userMessage: [{ type: "text", text: "again" }],
      }),
    ).toThrow(/already in flight/);
    // Drain the first so the busy-thread reservation is released.
    for await (const _ev of firstIter) {
      void _ev;
    }
  });

  test("isThreadBusy is true during an in-flight Run, false otherwise (AC #7)", async () => {
    const { executor, threadId } = await setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "text_start", blockIndex: 0 },
          { type: "text_delta", blockIndex: 0, delta: "hi" },
          { type: "text_end", blockIndex: 0 },
          { type: "done", finishReason: "stop" },
        ],
      },
    });

    // Idle before any Run.
    expect(executor.isThreadBusy(threadId)).toBe(false);

    // startRun reserves the thread synchronously, before the iterator advances.
    const iter = executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] });
    expect(executor.isThreadBusy(threadId)).toBe(true);
    // An unrelated thread is never busy.
    expect(executor.isThreadBusy("other-thread")).toBe(false);

    // Draining to completion releases the reservation.
    for await (const _ev of iter) {
      void _ev;
    }
    expect(executor.isThreadBusy(threadId)).toBe(false);
  });
});

// ─── newest-terminal accessor ───────────────────────────────────────────────

describe("RunExecutor — status accessors", () => {
  // Each accessor scan keys on endedAt; the store stamps endedAt at runs.create
  // /complete/fail/cancel time. Running real runs sequentially yields strictly
  // increasing endedAt values, so "newest" == "last finalized".

  async function completedRun(executor: RunExecutor, threadId: string): Promise<void> {
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "ok" }] }));
  }

  test("no Runs → newestTerminalRun null", async () => {
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
    });
    expect(executor.newestTerminalRun(threadId)).toBeNull();
  });

  test("a completed Run → newestTerminalRun is completed", async () => {
    const { executor, threadId } = await setup({
      fixtures: { "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }] },
    });
    await completedRun(executor, threadId);
    const terminal = executor.newestTerminalRun(threadId);
    expect(terminal?.status).toBe("completed");
  });

  test("a failed Run → newestTerminalRun is failed", async () => {
    const { executor, threadId } = await setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [
          { type: "error", code: "rate_limited", message: "429", retryable: true },
          { type: "done", finishReason: "error" },
        ],
      },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "x" }] }));
    const terminal = executor.newestTerminalRun(threadId);
    expect(terminal?.status).toBe("failed");
  });

  test("a cancelled Run → newestTerminalRun is cancelled", async () => {
    const { executor, threadId } = await setup({
      fixtures: {
        "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "cancelled" }],
      },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "x" }] }));
    const terminal = executor.newestTerminalRun(threadId);
    expect(terminal?.status).toBe("cancelled");
  });

  test("failed then a newer completed Run → newestTerminalRun is the completed one (ordering trap)", async () => {
    // Build a dedicated harness with a MONOTONIC store clock so the second
    // Run's endedAt is strictly greater than the first's — otherwise two
    // sub-millisecond runs could collide and the scan (strict `>`) would keep
    // the older failed row. Two model fixtures: the first Run fails, the second
    // (via modelOverride) completes.
    const db = openHiveDb(":memory:");
    const threadsStore = createThreadsStore(db);
    let tick = 1000;
    const runsStore = createRunsStore(db, () => tick++);
    const secrets = makeSecrets();
    await secrets.setApiKey("anthropic", "sk-test");
    const catalog = makeCatalogStub([makeAgent({ agentId: "test-agent" })]);
    const gateway = makeFakeGateway({
      "anthropic/claude-haiku-4-5": [
        { type: "error", code: "rate_limited", message: "429", retryable: true },
        { type: "done", finishReason: "error" },
      ],
      "anthropic/claude-opus-4-7": [{ type: "done", finishReason: "stop" }],
    });
    const executor = createRunExecutor({
      threads: threadsStore,
      runs: runsStore,
      catalog,
      gateway,
      secrets,
    });
    const threadId = threadsStore.create({ agentId: "test-agent" }).id;

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "first" }] }));
    expect(executor.newestTerminalRun(threadId)?.status).toBe("failed");

    await collect(
      executor.startRun({
        threadId,
        userMessage: [{ type: "text", text: "retry" }],
        modelOverride: "anthropic/claude-opus-4-7",
      }),
    );
    // The newer completed Run has the larger endedAt, so it wins the scan.
    const terminal = executor.newestTerminalRun(threadId);
    expect(terminal?.status).toBe("completed");
  });
});
