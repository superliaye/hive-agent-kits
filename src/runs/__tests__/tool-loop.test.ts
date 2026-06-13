import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import type { Agent, Catalog, CatalogEvents } from "../../catalog/index.ts";
import { type HiveDb, openHiveDb } from "../../db/hive-db.ts";
import { AgentId } from "../../lib/ids.ts";
import { runtimeRoot } from "../../lib/paths.ts";
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
import type {
  CapConfigPort,
  FsRunnerPort,
  PermissionPort,
  ShellRunnerPort,
  SkillResolverPort,
} from "../effect/ports.ts";
import { createRunExecutor, type RunExecutor } from "../executor.ts";
import { createRunsStore } from "../store.ts";
import type { RunEvent, RunModuleEvents } from "../types.ts";

const MODEL = "anthropic/claude-haiku-4-5";

function makeAgent(overrides: Partial<Omit<Agent, "agentId">> & { agentId?: string } = {}): Agent {
  const { agentId, ...rest } = overrides;
  return {
    agentId: AgentId.parse(agentId ?? "test-agent"),
    backend: "native",
    domain: "Test",
    bindings: { skills: [], snippets: [], tools: [], mcp: [] },
    config: {},
    promptBody: "",
    layer: "bundled",
    hasFork: false,
    path: "/p/HARNESS.md",
    ...rest,
  };
}

function makeCatalogStub(agents: Agent[]): Catalog {
  // Fresh empty emitter — the executor doesn't read catalog events.
  const events = new TypedEmitter<CatalogEvents>();
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
    events,
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
  fs?: FsRunnerPort;
  skillResolver?: SkillResolverPort;
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
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.skillResolver ? { skillResolver: opts.skillResolver } : {}),
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

// ─── Grace-turn: no dangling tool_use persisted ──────────────────────────────

describe("tool-loop — grace turn strips dangling tool_use", () => {
  test("cap reached, model still emits tool_use on grace turn → no dangling tool_use, completed", async () => {
    // Always emits tool_use even when no tools are offered (grace turn).
    const stubbornScript = (input: CompletionInput): GatewayEvent[] => {
      const toolResults = input.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_result").length;
      return [
        { type: "tool_use_start", blockIndex: 0, id: `tu_${toolResults}`, name: "run_shell" },
        {
          type: "tool_use_end",
          blockIndex: 0,
          id: `tu_${toolResults}`,
          args: { command: "node", args: [] },
        },
        { type: "done", finishReason: "tool_use" },
      ];
    };
    const { threads, executor, threadId } = await build({
      script: stubbornScript,
      capConfig: { maxIterations: () => 1 },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }),
    );
    expect(events[events.length - 1]?.type).toBe("run.completed");

    // No tool_use block may lack a matching tool_result in the final history.
    const msgs = threads.listMessages(threadId);
    const blocks = msgs.flatMap((m) => m.content);
    const toolUseIds = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    const toolResultIds = new Set(
      blocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
    );
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});

// ─── Abort: aborted signal short-circuits dispatch ───────────────────────────

describe("tool-loop — abort short-circuits dispatch", () => {
  test("cancelRun on run.started → shell never runs, ends run.cancelled", async () => {
    const { executor, threadId, shellCalls } = await build({
      script: alwaysToolScript("run_shell", { command: "node", args: [] }),
    });
    let cancelled = false;
    const out: RunEvent[] = [];
    for await (const ev of executor.startRun({
      threadId,
      userMessage: [{ type: "text", text: "go" }],
    })) {
      out.push(ev);
      if (ev.type === "run.started" && !cancelled) {
        cancelled = true;
        executor.cancelRun(ev.runId);
      }
    }
    // Signal aborted before the first turn streamed any tool_use → no dispatch,
    // so the shell handler was never invoked.
    expect(shellCalls).toHaveLength(0);
    expect(out[out.length - 1]?.type).toBe("run.cancelled");
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

// ─── D-1: file tools through the loop ────────────────────────────────────────

// In-memory FsRunner for the loop-level round-trip. Keyed by absolute path.
function memFs(): { fs: FsRunnerPort; files: Map<string, string> } {
  const files = new Map<string, string>();
  const fs: FsRunnerPort = {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    fileExists: async (p) => files.has(p),
  };
  return { fs, files };
}

describe("tool-loop — D-1 file tools (write then read round-trip)", () => {
  test("model writes a file then reads it back; tool_result carries the content", async () => {
    // Turn 1: write. Turn 2 (after the write tool_result): read. Turn 3: text.
    let turn = 0;
    const script = (input: CompletionInput): GatewayEvent[] => {
      const toolsOffered = input.tools !== undefined && input.tools.length > 0;
      if (!toolsOffered) {
        return [
          { type: "text_start", blockIndex: 0 },
          { type: "text_delta", blockIndex: 0, delta: "done" },
          { type: "text_end", blockIndex: 0 },
          { type: "done", finishReason: "stop" },
        ];
      }
      turn += 1;
      if (turn === 1) {
        return [
          { type: "tool_use_start", blockIndex: 0, id: "tu_w", name: "write" },
          {
            type: "tool_use_end",
            blockIndex: 0,
            id: "tu_w",
            args: { path: "out.txt", content: "PERSISTED" },
          },
          { type: "done", finishReason: "tool_use" },
        ];
      }
      if (turn === 2) {
        return [
          { type: "tool_use_start", blockIndex: 0, id: "tu_r", name: "read" },
          { type: "tool_use_end", blockIndex: 0, id: "tu_r", args: { path: "out.txt" } },
          { type: "done", finishReason: "tool_use" },
        ];
      }
      return [
        { type: "text_start", blockIndex: 0 },
        { type: "text_delta", blockIndex: 0, delta: "done" },
        { type: "text_end", blockIndex: 0 },
        { type: "done", finishReason: "stop" },
      ];
    };
    const { fs } = memFs();
    const { threads, executor, threadId } = await build({
      script,
      fs,
      agent: { bindings: { skills: [], snippets: [], tools: ["read", "write"], mcp: [] } },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }),
    );
    expect(events[events.length - 1]?.type).toBe("run.completed");
    // The read tool_result carried the content the write tool persisted.
    const readResult = threads
      .listMessages(threadId)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.tool_use_id === "tu_r");
    expect(readResult).toBeDefined();
    if (readResult?.type === "tool_result") {
      expect(readResult.content).toBe("PERSISTED");
      expect(readResult.is_error).toBeUndefined();
    }
  });

  test("edit with a missing old_str → isError tool_result, loop continues to completed", async () => {
    const script = toolThenTextScript({
      toolName: "edit",
      toolInput: { path: "out.txt", old_str: "ABSENT", new_str: "x" },
      toolTurns: 1,
    });
    const { fs } = memFs();
    const { threads, executor, threadId } = await build({
      script,
      fs,
      agent: { bindings: { skills: [], snippets: [], tools: ["edit"], mcp: [] } },
    });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }),
    );
    expect(events[events.length - 1]?.type).toBe("run.completed");
    const result = threads
      .listMessages(threadId)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") expect(result.is_error).toBe(true);
  });

  test("a path escape (`../x`) is rejected with an isError tool_result", async () => {
    const script = toolThenTextScript({
      toolName: "write",
      toolInput: { path: "../escape.txt", content: "x" },
      toolTurns: 1,
    });
    const { fs, files } = memFs();
    const { threads, executor, threadId } = await build({
      script,
      fs,
      agent: { bindings: { skills: [], snippets: [], tools: ["write"], mcp: [] } },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    const result = threads
      .listMessages(threadId)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") expect(result.is_error).toBe(true);
    // Nothing was written outside the workspace.
    expect(files.size).toBe(0);
  });

  // P-4: file-tool describe() projects the model-supplied workspace-relative
  // path (the call's target ref) as an audit ref (like run_shell's command),
  // plus an {oldLen,newLen} summary for edit — and NEVER the file content.
  test("write audit ref carries the path, never the content", async () => {
    const script = toolThenTextScript({
      toolName: "write",
      toolInput: { path: "notes/out.txt", content: "TOP-SECRET-CONTENT" },
      toolTurns: 1,
    });
    const { fs } = memFs();
    const { executor, threadId } = await build({
      script,
      fs,
      agent: { bindings: { skills: [], snippets: [], tools: ["write"], mcp: [] } },
    });
    const requested: Array<RunModuleEvents["run.tool_use.requested"]> = [];
    executor.events.on("run.tool_use.requested", (e) => {
      requested.push(e);
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    const writeReq = requested.find((e) => e.tool === "write");
    expect(writeReq).toBeDefined();
    expect(writeReq?.path).toBe("notes/out.txt");
    expect(JSON.stringify(requested)).not.toContain("TOP-SECRET-CONTENT");
  });

  test("edit audit ref carries path + {oldLen,newLen}, never old/new content", async () => {
    const { fs } = memFs();
    // describe() projects path + length summary from the call input (audit-first,
    // before the side effect) — the file need not exist for the requested event.
    const script = toolThenTextScript({
      toolName: "edit",
      toolInput: { path: "doc.txt", old_str: "BEFORE", new_str: "AFTER-LONGER" },
      toolTurns: 1,
    });
    const { executor, threadId } = await build({
      script,
      fs,
      agent: { bindings: { skills: [], snippets: [], tools: ["edit"], mcp: [] } },
    });
    const requested: Array<RunModuleEvents["run.tool_use.requested"]> = [];
    executor.events.on("run.tool_use.requested", (e) => {
      requested.push(e);
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    const editReq = requested.find((e) => e.tool === "edit");
    expect(editReq).toBeDefined();
    expect(editReq?.path).toBe("doc.txt");
    expect(editReq?.editSummary).toEqual({ oldLen: 6, newLen: 12 });
    const blob = JSON.stringify(requested);
    expect(blob).not.toContain("BEFORE");
    expect(blob).not.toContain("AFTER-LONGER");
  });

  // P-6: describe() runs before run() and has no ctx.cwd, so a path-escaping call
  // is still projected into the requested audit ref verbatim (over-records per
  // ADR-0004) while run() rejects it with isError.
  test("an escaping path is still projected as a ref while run() returns isError", async () => {
    const script = toolThenTextScript({
      toolName: "write",
      toolInput: { path: "../escape.txt", content: "x" },
      toolTurns: 1,
    });
    const { fs, files } = memFs();
    const { threads, executor, threadId } = await build({
      script,
      fs,
      agent: { bindings: { skills: [], snippets: [], tools: ["write"], mcp: [] } },
    });
    const requested: Array<RunModuleEvents["run.tool_use.requested"]> = [];
    executor.events.on("run.tool_use.requested", (e) => {
      requested.push(e);
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    const writeReq = requested.find((e) => e.tool === "write");
    expect(writeReq?.path).toBe("../escape.txt");
    const result = threads
      .listMessages(threadId)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    if (result?.type === "tool_result") expect(result.is_error).toBe(true);
    expect(files.size).toBe(0);
  });
});

// ─── C4: native ToolContext.cwd resolution ──────────────────────────────────

describe("tool-loop — C4 Working Directory (native ctx.cwd)", () => {
  test("no thread/agent default → ctx.cwd is the tier-3 per-Agent workspace (no regression)", async () => {
    const seenCwd: string[] = [];
    const { executor, threadId } = await build({
      script: toolThenTextScript({
        toolName: "run_shell",
        toolInput: { command: "node", args: [] },
        toolTurns: 1,
      }),
      shell: {
        run: async ({ cwd }) => {
          seenCwd.push(cwd);
          return { stdout: "OK", stderr: "", exitCode: 0 };
        },
      },
      // makeAgent default config is { model: MODEL } — no workingDir.
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    expect(seenCwd).toEqual([join(runtimeRoot(), "agents", "test-agent", "workspace")]);
  });

  test("agent config.workingDir (tier 2) drives ctx.cwd", async () => {
    const seenCwd: string[] = [];
    const { executor, threadId } = await build({
      script: toolThenTextScript({
        toolName: "run_shell",
        toolInput: { command: "node", args: [] },
        toolTurns: 1,
      }),
      shell: {
        run: async ({ cwd }) => {
          seenCwd.push(cwd);
          return { stdout: "OK", stderr: "", exitCode: 0 };
        },
      },
      agent: { config: { model: MODEL, workingDir: "/agent/default/dir" } },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    expect(seenCwd).toEqual(["/agent/default/dir"]);
  });

  test("Thread workingDir (tier 1) wins over the agent default", async () => {
    const seenCwd: string[] = [];
    const { threads, executor, threadId } = await build({
      script: toolThenTextScript({
        toolName: "run_shell",
        toolInput: { command: "node", args: [] },
        toolTurns: 1,
      }),
      shell: {
        run: async ({ cwd }) => {
          seenCwd.push(cwd);
          return { stdout: "OK", stderr: "", exitCode: 0 };
        },
      },
      agent: { config: { model: MODEL, workingDir: "/agent/default/dir" } },
    });
    await threads.setScope(threadId, { workingDir: "/thread/pick" });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    expect(seenCwd).toEqual(["/thread/pick"]);
  });
});

// ─── D-3: load_skill ─────────────────────────────────────────────────────────

function stubSkillResolver(
  skills: Record<string, { description: string; body: string }>,
): SkillResolverPort {
  return {
    list: (boundNames) =>
      boundNames
        .filter((n) => n in skills)
        .map((n) => ({ name: n, description: skills[n]?.description ?? "" })),
    load: (boundNames, name) =>
      boundNames.includes(name) && name in skills ? skills[name] : undefined,
  };
}

describe("tool-loop — D-3 load_skill", () => {
  test("model loads a bound skill; tool_result carries the body; run.skill_loaded emitted (no body)", async () => {
    const skillResolver = stubSkillResolver({
      diagnose: { description: "Debug hard problems", body: "FULL DIAGNOSE BODY" },
    });
    const script = toolThenTextScript({
      toolName: "load_skill",
      toolInput: { name: "diagnose" },
      toolTurns: 1,
    });
    const skillEvents: Array<{ skill: string }> = [];
    const { threads, executor, threadId } = await build({
      script,
      skillResolver,
      agent: { bindings: { skills: ["diagnose"], snippets: [], tools: ["load_skill"], mcp: [] } },
    });
    executor.events.on("run.skill_loaded", (e) => {
      skillEvents.push({ skill: e.skill });
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));

    const result = threads
      .listMessages(threadId)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") expect(result.content).toBe("FULL DIAGNOSE BODY");

    // Audit: exactly one skill-load event, carrying the NAME (a ref), not the body.
    expect(skillEvents).toEqual([{ skill: "diagnose" }]);
    expect(JSON.stringify(skillEvents)).not.toContain("FULL DIAGNOSE BODY");
  });

  test("an unbound skill name → isError tool_result, no skill_loaded event", async () => {
    const script = toolThenTextScript({
      toolName: "load_skill",
      // grill-me exists in the resolver but is NOT bound on this agent.
      toolInput: { name: "grill-me" },
      toolTurns: 1,
    });
    const skillEvents: string[] = [];
    const { threads, executor, threadId } = await build({
      script,
      // grill-me resolves but is not in this agent's bindings → must be refused.
      skillResolver: stubSkillResolver({
        diagnose: { description: "Debug", body: "BODY" },
        "grill-me": { description: "Grill", body: "GRILL BODY" },
      }),
      agent: { bindings: { skills: ["diagnose"], snippets: [], tools: ["load_skill"], mcp: [] } },
    });
    executor.events.on("run.skill_loaded", (e) => {
      skillEvents.push(e.skill);
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));

    const result = threads
      .listMessages(threadId)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") expect(result.is_error).toBe(true);
    expect(skillEvents).toHaveLength(0);
  });
});

// ─── D-4: progressive-disclosure listing injected at Run start ───────────────

describe("tool-loop — D-4 Run-start skill listing in system prompt", () => {
  // Capture the `system` the model receives on the first turn.
  function capturingScript(captured: { system?: string }): (i: CompletionInput) => GatewayEvent[] {
    return (input) => {
      captured.system = input.system;
      return [
        { type: "text_start", blockIndex: 0 },
        { type: "text_delta", blockIndex: 0, delta: "ok" },
        { type: "text_end", blockIndex: 0 },
        { type: "done", finishReason: "stop" },
      ];
    };
  }

  test("two bound skills + load_skill bound → both one-line descriptions present, bodies absent", async () => {
    const captured: { system?: string } = {};
    const { executor, threadId } = await build({
      script: capturingScript(captured),
      skillResolver: stubSkillResolver({
        diagnose: { description: "Debug hard problems", body: "DIAGNOSE BODY" },
        "grill-me": { description: "Stress-test a plan", body: "GRILL BODY" },
      }),
      agent: {
        promptBody: "You are a test agent.",
        bindings: {
          skills: ["diagnose", "grill-me"],
          snippets: [],
          tools: ["load_skill"],
          mcp: [],
        },
      },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    expect(captured.system).toContain("diagnose: Debug hard problems");
    expect(captured.system).toContain("grill-me: Stress-test a plan");
    expect(captured.system).toContain("load_skill");
    // Bodies are NOT injected — only one-liners.
    expect(captured.system).not.toContain("DIAGNOSE BODY");
    expect(captured.system).not.toContain("GRILL BODY");
    // The authored prompt body is preserved.
    expect(captured.system).toContain("You are a test agent.");
  });

  test("skills bound but load_skill NOT bound → no listing block (uncallable tool not advertised)", async () => {
    const captured: { system?: string } = {};
    const { executor, threadId } = await build({
      script: capturingScript(captured),
      skillResolver: stubSkillResolver({
        diagnose: { description: "Debug hard problems", body: "DIAGNOSE BODY" },
        "grill-me": { description: "Stress-test a plan", body: "GRILL BODY" },
      }),
      agent: {
        promptBody: "You are a test agent.",
        // Skills are bound, but load_skill is NOT among the bound tools.
        bindings: { skills: ["diagnose", "grill-me"], snippets: [], tools: [], mcp: [] },
      },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    // The block must be suppressed: surfacing skill one-liners while
    // withholding the load tool would advertise an uncallable tool.
    expect(captured.system).toBe("You are a test agent.");
    expect(captured.system).not.toContain("Available skills");
    expect(captured.system).not.toContain("diagnose: Debug hard problems");
  });

  test("no bound skills → no listing block injected (just the prompt body)", async () => {
    const captured: { system?: string } = {};
    const { executor, threadId } = await build({
      script: capturingScript(captured),
      skillResolver: stubSkillResolver({}),
      agent: {
        promptBody: "Bare agent.",
        bindings: { skills: [], snippets: [], tools: [], mcp: [] },
      },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    expect(captured.system).toBe("Bare agent.");
    expect(captured.system).not.toContain("Available skills");
  });
});
