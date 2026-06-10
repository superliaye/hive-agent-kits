import { afterEach, describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import type { Agent, Catalog } from "../../catalog/index.ts";
import { type HiveDb, openHiveDb } from "../../db/hive-db.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { makeFakeAdapter } from "../../model-gateway/adapters/fake.ts";
import { createGateway, type ModelGateway } from "../../model-gateway/index.ts";
import type { CompletionInput, GatewayEvent } from "../../model-gateway/types.ts";
import {
  SecretsLive,
  type SecretsSvc,
  Secrets as SecretsTag,
} from "../../secrets/effect/secrets-live.ts";
import { createThreadsStore } from "../../threads/store.ts";
import type { CapConfigPort, PermissionPort, ShellRunnerPort } from "../effect/ports.ts";
import { createRunExecutor, type RunExecutor } from "../executor.ts";
import { createRunsStore } from "../store.ts";
import type { RunEvent } from "../types.ts";

const MODEL = "anthropic/claude-haiku-4-5";

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
    path: "/p/HARNESS.md",
    ...overrides,
  };
}

function makeCatalogStub(agents: Agent[]): Catalog {
  const events = new TypedEmitter<Record<string, never>>();
  return {
    list: () => agents,
    get: (id) => agents.find((a) => a.agentId === id),
    updateBindings: async () => {
      throw new Error("nope");
    },
    resetToBundled: async () => {
      throw new Error("nope");
    },
    start: async () => {},
    rescan: async () => {},
    // biome-ignore lint/suspicious/noExplicitAny: stub emitter generic differs; executor doesn't read catalog events.
    events: events as any,
    dispose: () => {},
  };
}

const secretsRuntimes: Array<{ dispose(): Promise<void> }> = [];
function makeSecrets(): SecretsSvc {
  const runtime = ManagedRuntime.make(SecretsLive({ mode: "memory" }));
  secretsRuntimes.push(runtime);
  return runtime.runSync(SecretsTag);
}
afterEach(async () => {
  for (const rt of secretsRuntimes.splice(0)) await rt.dispose();
});

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// Fixture helper: a function-form script keyed off the live CompletionInput.
// Returns tool_use turns until `toolTurns` tool_results are present in history,
// then a final text turn. This is the exact pattern the plan calls out: the
// fake keys off the full input so the loop is testable with the existing fake.
function toolThenTextScript(opts: {
  toolName: string;
  toolInput: unknown;
  toolTurns: number; // how many tool_use turns to emit before going to text
}): (input: CompletionInput) => GatewayEvent[] {
  let id = 0;
  return (input) => {
    const toolResults = input.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result").length;
    // No tools offered (grace turn) → must answer with text.
    const toolsOffered = input.tools !== undefined && input.tools.length > 0;
    if (!toolsOffered || toolResults >= opts.toolTurns) {
      return [
        { type: "text_start", blockIndex: 0 },
        { type: "text_delta", blockIndex: 0, delta: "final answer" },
        { type: "text_end", blockIndex: 0 },
        { type: "done", finishReason: "stop" },
      ];
    }
    id += 1;
    return [
      { type: "tool_use_start", blockIndex: 0, id: `tu_${id}`, name: opts.toolName },
      { type: "tool_use_end", blockIndex: 0, id: `tu_${id}`, args: opts.toolInput },
      { type: "done", finishReason: "tool_use" },
    ];
  };
}

// Always returns a tool_use turn (when tools offered) — never converges. Used
// to exercise the cap + grace path.
function alwaysToolScript(
  toolName: string,
  toolInput: unknown,
): (i: CompletionInput) => GatewayEvent[] {
  let id = 0;
  return (input) => {
    const toolsOffered = input.tools !== undefined && input.tools.length > 0;
    if (!toolsOffered) {
      return [
        { type: "text_start", blockIndex: 0 },
        { type: "text_delta", blockIndex: 0, delta: "forced summary" },
        { type: "text_end", blockIndex: 0 },
        { type: "done", finishReason: "stop" },
      ];
    }
    id += 1;
    return [
      { type: "tool_use_start", blockIndex: 0, id: `tu_${id}`, name: toolName },
      { type: "tool_use_end", blockIndex: 0, id: `tu_${id}`, args: toolInput },
      { type: "done", finishReason: "tool_use" },
    ];
  };
}

type Built = {
  db: HiveDb;
  threads: ReturnType<typeof createThreadsStore>;
  executor: RunExecutor;
  threadId: string;
  shellCalls: Array<{ command: string; args: string[] }>;
};

async function build(opts: {
  script: (input: CompletionInput) => GatewayEvent[];
  agent?: Partial<Agent>;
  permission?: PermissionPort;
  capConfig?: CapConfigPort;
  shell?: ShellRunnerPort;
}): Promise<Built> {
  const db = openHiveDb(":memory:");
  const threads = createThreadsStore(db);
  const runsStore = createRunsStore(db);
  const secrets = makeSecrets();
  await secrets.setApiKey("anthropic", "sk-test");
  const agent = makeAgent({
    bindings: { skills: [], snippets: [], tools: ["run_shell"], mcp: [] },
    commandAllowlist: ["node", "echo"],
    config: { model: MODEL },
    ...opts.agent,
  });
  const catalog = makeCatalogStub([agent]);
  const gw: ModelGateway = createGateway();
  gw.registerAdapter(makeFakeAdapter(["anthropic"], { [MODEL]: opts.script }));

  const shellCalls: Array<{ command: string; args: string[] }> = [];
  const shell: ShellRunnerPort = opts.shell ?? {
    run: async ({ command, args }) => {
      shellCalls.push({ command, args });
      return { stdout: "TOOL-OK", stderr: "", exitCode: 0 };
    },
  };
  const executor = createRunExecutor({
    threads,
    runs: runsStore,
    catalog,
    gateway: gw,
    secrets,
    shell,
    ...(opts.permission ? { permission: opts.permission } : {}),
    ...(opts.capConfig ? { capConfig: opts.capConfig } : {}),
  });
  const threadId = threads.create({ agentId: agent.agentId }).id;
  return { db, threads, executor, threadId, shellCalls };
}

// ─── AC1: shell command runs, loop continues to a final answer ───────────────

describe("tool-loop — AC1 (native agent runs run_shell, loop continues)", () => {
  test("run_shell sent (bound), gate allows (allowlisted), ends completed with final text + tool_result in history", async () => {
    const { threads, executor, threadId, shellCalls } = await build({
      script: toolThenTextScript({
        toolName: "run_shell",
        toolInput: { command: "node", args: ["-e", "1"] },
        toolTurns: 1,
      }),
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }),
    );
    // Final lifecycle event is run.completed.
    expect(events[events.length - 1]?.type).toBe("run.completed");
    // The shell actually ran (gate allowed it).
    expect(shellCalls).toEqual([{ command: "node", args: ["-e", "1"] }]);
    // History: user, assistant(tool_use), user(tool_result), assistant(text).
    const msgs = threads.listMessages(threadId);
    const toolResult = msgs.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toEqual([{ type: "text", text: "final answer" }]);
  });
});

// ─── AC2: termination paths ──────────────────────────────────────────────────

describe("tool-loop — AC2 (termination)", () => {
  test("(a) text turn 1 → completed", async () => {
    const { executor, threadId } = await build({
      script: () => [
        { type: "text_start", blockIndex: 0 },
        { type: "text_delta", blockIndex: 0, delta: "hi" },
        { type: "text_end", blockIndex: 0 },
        { type: "done", finishReason: "stop" },
      ],
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    expect(events[events.length - 1]?.type).toBe("run.completed");
  });

  test("(b) cap=1, always tool_use → exactly 1 dispatch + 1 grace turn → completed", async () => {
    const { executor, threadId, shellCalls } = await build({
      script: alwaysToolScript("run_shell", { command: "node", args: [] }),
      capConfig: { maxIterations: () => 1 },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }),
    );
    // One model turn dispatched the tool; the grace turn (turn 2, tools
    // stripped) produced the forced summary.
    expect(shellCalls).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe("run.completed");
  });

  test("(c) tool gateway error mid-loop → run.failed", async () => {
    let turn = 0;
    const { executor, threadId } = await build({
      script: () => {
        turn += 1;
        if (turn === 1) {
          return [
            { type: "tool_use_start", blockIndex: 0, id: "tu_1", name: "run_shell" },
            { type: "tool_use_end", blockIndex: 0, id: "tu_1", args: { command: "node" } },
            { type: "done", finishReason: "tool_use" },
          ];
        }
        return [
          { type: "error", code: "rate_limited", message: "429", retryable: true },
          { type: "done", finishReason: "error" },
        ];
      },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }),
    );
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "run.failed") expect(failed.error.code).toBe("rate_limited");
  });

  test("(d) default-unlimited (cap=0): N tool turns then text, no grace, completed", async () => {
    const { executor, threadId, shellCalls } = await build({
      script: toolThenTextScript({
        toolName: "run_shell",
        toolInput: { command: "node", args: [] },
        toolTurns: 3,
      }),
      // no capConfig → executor default cap=0 (unlimited)
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }),
    );
    // All 3 dispatches happened (no premature cap), ending completed.
    expect(shellCalls).toHaveLength(3);
    expect(events[events.length - 1]?.type).toBe("run.completed");
  });
});

// ─── AC3: cap from configuration changes behavior ────────────────────────────

describe("tool-loop — AC3 (cap drives dispatch count)", () => {
  async function dispatchCount(cap: number): Promise<number> {
    const { executor, threadId, shellCalls } = await build({
      script: alwaysToolScript("run_shell", { command: "node", args: [] }),
      capConfig: { maxIterations: () => cap },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    return shellCalls.length;
  }

  test("cap=1 vs cap=3 → dispatch count differs (1 vs 3)", async () => {
    expect(await dispatchCount(1)).toBe(1);
    expect(await dispatchCount(3)).toBe(3);
  });
});

// ─── AC4: audit events on the right sources, redaction ───────────────────────

describe("tool-loop — AC4 (audit via module write path, redaction)", () => {
  test("run.tool_use.executed on run source; permission.decided on permission source; no raw args/stdout", async () => {
    const { executor, threadId } = await build({
      script: toolThenTextScript({
        toolName: "run_shell",
        toolInput: { command: "node", args: ["--secret-flag", "value"] },
        toolTurns: 1,
      }),
    });

    const runEvents: Array<{ type: string; payload: unknown }> = [];
    const permEvents: Array<{ type: string; payload: unknown }> = [];
    executor.events.on("run.tool_use.requested", (e) => {
      runEvents.push({ type: "run.tool_use.requested", payload: e });
    });
    executor.events.on("run.tool_use.executed", (e) => {
      runEvents.push({ type: "run.tool_use.executed", payload: e });
    });
    executor.permissionEvents.on("permission.requested", (e) => {
      permEvents.push({ type: "permission.requested", payload: e });
    });
    executor.permissionEvents.on("permission.decided", (e) => {
      permEvents.push({ type: "permission.decided", payload: e });
    });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));

    expect(runEvents.map((e) => e.type)).toContain("run.tool_use.executed");
    expect(permEvents.map((e) => e.type)).toContain("permission.decided");

    // Redaction: serialized event payloads must not contain raw arg strings or stdout.
    const blob = JSON.stringify({ runEvents, permEvents });
    expect(blob).not.toContain("--secret-flag");
    expect(blob).not.toContain("value");
    expect(blob).not.toContain("TOOL-OK");
    // The command NAME (a ref) IS present.
    expect(blob).toContain("node");
  });

  test("permission deny path: run_shell not in allowlist → denied, shell never runs, tool_result is error", async () => {
    const { threads, executor, threadId, shellCalls } = await build({
      script: toolThenTextScript({
        toolName: "run_shell",
        toolInput: { command: "python", args: [] },
        toolTurns: 1,
      }),
      agent: { commandAllowlist: ["node"] }, // python not allowed
    });
    const decided: string[] = [];
    executor.permissionEvents.on("permission.decided", (e) => {
      decided.push(e.outcome);
    });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));

    expect(decided).toContain("deny");
    expect(shellCalls).toHaveLength(0);
    const toolResult = threads
      .listMessages(threadId)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") expect(toolResult.is_error).toBe(true);
  });
});
