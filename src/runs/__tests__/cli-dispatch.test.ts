// C2b cli-dispatch-arm: the claude-code/codex backend dispatch through the
// CliSpawnerPort. Streamed stdout → Thread assistant message + run.completed;
// nonzero exit → run.failed with the stderr tail; abort → run.cancelled;
// spawn_failed → run.failed; redacted `backend` audit row.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { AuditLive, type AuditSvc, Audit as AuditTag } from "../../audit/effect/audit-live.ts";
import { wireSubscriptions } from "../../audit/subscriptions.ts";
import type { Agent, Catalog, CatalogEvents } from "../../catalog/index.ts";
import { openHiveDb } from "../../db/hive-db.ts";
import { AgentId } from "../../lib/ids.ts";
import { runtime, runtimeRoot } from "../../lib/paths.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { createGateway, type ModelGateway } from "../../model-gateway/index.ts";
import {
  SecretsLive,
  type SecretsSvc,
  Secrets as SecretsTag,
} from "../../secrets/effect/secrets-live.ts";
import { createThreadsStore } from "../../threads/store.ts";
import type {
  CliSpawnerPort,
  CliSpawnInput,
  CliSpawnResult,
  FsCopyPort,
  ProjectableSkill,
  SkillProjectionPort,
  SkillResolverPort,
} from "../effect/ports.ts";
import { CLI_BACKEND_PREAMBLE, createRunExecutor, type RunExecutor } from "../executor.ts";
import { createRunsStore } from "../store.ts";
import { createDefaultFsCopy } from "../tools/cli-skill-projection.ts";
import { memoryCliSpawner } from "../tools/cli-spawn.ts";
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

function makeGateway(): ModelGateway {
  // No native turns happen on the CLI path; an empty gateway is sufficient.
  return createGateway();
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

async function* fromChunks(chunks: readonly string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

// Representative claude `--output-format stream-json` JSONL: an init event
// carrying session_id, an assistant message with text blocks, then a result.
function claudeStreamJsonl(opts: { sessionId: string; text: string }): string[] {
  return [
    `${JSON.stringify({ type: "system", subtype: "init", session_id: opts.sessionId })}\n`,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: opts.text }] },
    })}\n`,
    `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
  ];
}

// Representative codex `exec --json` JSONL: thread.started carrying thread_id,
// then an item.completed agent_message.
function codexJsonl(opts: { threadId: string; text: string }): string[] {
  return [
    `${JSON.stringify({ type: "thread.started", thread_id: opts.threadId })}\n`,
    `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: opts.text },
    })}\n`,
  ];
}

type FakeSpawnConfig = {
  stdout?: readonly string[];
  stderr?: readonly string[];
  exitCode?: number;
  spawnFailed?: string;
};

// A fake CliSpawnerPort recording the last spawn input, returning configured
// streams. Mirrors the C2a port's shape (stdout/stderr AsyncIterable, exit
// Promise, or spawn_failed value).
function makeFakeSpawner(config: FakeSpawnConfig): {
  spawner: CliSpawnerPort;
  lastInput(): CliSpawnInput | undefined;
} {
  let last: CliSpawnInput | undefined;
  return {
    spawner: {
      spawn(input: CliSpawnInput): CliSpawnResult {
        last = input;
        if (config.spawnFailed !== undefined) {
          return { kind: "spawn_failed", message: config.spawnFailed };
        }
        return {
          kind: "spawned",
          stdout: fromChunks(config.stdout ?? []),
          stderr: fromChunks(config.stderr ?? []),
          exit: Promise.resolve({ exitCode: config.exitCode ?? 0 }),
        };
      },
    },
    lastInput: () => last,
  };
}

const runtimes: Array<{ dispose(): Promise<void> }> = [];
function makeSecrets(): SecretsSvc {
  const runtime = ManagedRuntime.make(SecretsLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(SecretsTag);
}
function makeAudit(): AuditSvc {
  const runtime = ManagedRuntime.make(AuditLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(AuditTag);
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.dispose();
});

type Harness = {
  threads: ReturnType<typeof createThreadsStore>;
  executor: RunExecutor;
  threadId: string;
};

async function setup(opts: {
  cliSpawner?: CliSpawnerPort;
  agent?: Partial<Agent>;
  skillProjection?: SkillProjectionPort;
  fsCopy?: FsCopyPort;
  skillResolver?: SkillResolverPort;
}): Promise<Harness> {
  const db = openHiveDb(":memory:");
  const threads = createThreadsStore(db);
  const runs = createRunsStore(db);
  const secrets = makeSecrets();
  await secrets.setApiKey("anthropic", "sk-test");
  const agent = makeAgent(opts.agent ?? {});
  const catalog = makeCatalogStub([agent]);
  const executor = createRunExecutor({
    threads,
    runs,
    catalog,
    gateway: makeGateway(),
    secrets,
    ...(opts.cliSpawner ? { cliSpawner: opts.cliSpawner } : {}),
    ...(opts.skillProjection ? { skillProjection: opts.skillProjection } : {}),
    ...(opts.fsCopy ? { fsCopy: opts.fsCopy } : {}),
    ...(opts.skillResolver ? { skillResolver: opts.skillResolver } : {}),
  });
  const threadId = threads.create({ agentId: agent.agentId }).id;
  return { threads, executor, threadId };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cli-dispatch — happy path", () => {
  test("parsed stream-json → assistant message + run.completed + completed Run row", async () => {
    const { spawner } = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "hello" }),
      exitCode: 0,
    });
    const { threads, executor, threadId } = await setup({ cliSpawner: spawner });

    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );

    const last = events[events.length - 1];
    expect(last?.type).toBe("run.completed");
    if (last?.type === "run.completed") {
      expect(last.finalMessage.content).toEqual([{ type: "text", text: "hello" }]);
      expect(executor.getRun(last.runId)?.status).toBe("completed");
      expect(executor.getRun(last.runId)?.finishReason).toBe("stop");
    }

    const assistant = threads.listMessages(threadId).find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("the spawner is reached with JSON-stream argv (not the old finalizeFailed arm)", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({ cliSpawner: fake.spawner });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    // The default agent resolves to the anthropic fallback model with no effort,
    // and an empty allowlist → --model (bare) + --permission-mode default, no
    // --allowedTools (P1.1/P1.2). The blank promptBody still gets the fixed CLI
    // preamble alone on --append-system-prompt (P1.4).
    expect(fake.lastInput()?.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-haiku-4-5",
      "--permission-mode",
      "default",
      "--append-system-prompt",
      CLI_BACKEND_PREAMBLE,
    ]);
    expect(fake.lastInput()?.stdin).toBe("hi");
  });

  test("empty stdout → '[no output]' assistant message", async () => {
    const { spawner } = makeFakeSpawner({ stdout: [], exitCode: 0 });
    const { threads, executor, threadId } = await setup({ cliSpawner: spawner });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    const assistant = threads.listMessages(threadId).find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "[no output]" }]);
  });

  test("CLI run with NO stored Hive secret reaches the spawner + completes (Fix 1)", async () => {
    // The CLI backends skip the no_credentials gate — they auth via their own
    // login. Prove a Run completes even with no provider secret stored.
    const db = openHiveDb(":memory:");
    const threads = createThreadsStore(db);
    const runs = createRunsStore(db);
    const secrets = makeSecrets(); // NO setApiKey — zero stored credentials.
    const agent = makeAgent();
    const catalog = makeCatalogStub([agent]);
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "hi there" }),
      exitCode: 0,
    });
    const executor = createRunExecutor({
      threads,
      runs,
      catalog,
      gateway: makeGateway(),
      secrets,
      cliSpawner: fake.spawner,
    });
    const threadId = threads.create({ agentId: agent.agentId }).id;

    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.completed");
    expect(fake.lastInput()?.command?.[0]).toBe("claude");
  });
});

describe("cli-dispatch — session continuity (Fix 4)", () => {
  test("claude turn 2 RESUMEs with the id captured on turn 1", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-abc", text: "first" }),
      exitCode: 0,
    });
    const { threads, executor, threadId } = await setup({ cliSpawner: fake.spawner });

    // Turn 1 — CREATE. The session id is captured + persisted. --model +
    // --permission-mode default + the CLI preamble ride along (P1.1/P1.2/P1.4).
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "t1" }] }));
    expect(fake.lastInput()?.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-haiku-4-5",
      "--permission-mode",
      "default",
      "--append-system-prompt",
      CLI_BACKEND_PREAMBLE,
    ]);
    expect(threads.getCliSession(threadId)).toEqual({
      backend: "claude-code",
      sessionId: "sess-abc",
    });

    // Turn 2 — RESUME with the stored id. --resume follows the model/permission
    // flags and precedes --append-system-prompt (deterministic ordering).
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "t2" }] }));
    expect(fake.lastInput()?.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-haiku-4-5",
      "--permission-mode",
      "default",
      "--resume",
      "sess-abc",
      "--append-system-prompt",
      CLI_BACKEND_PREAMBLE,
    ]);
    // Only the latest user turn rides stdin — the CLI replays its own history.
    expect(fake.lastInput()?.stdin).toBe("t2");
  });

  test("codex turn 2 RESUMEs via `exec resume <thread_id>` with the captured id", async () => {
    const fake = makeFakeSpawner({
      stdout: codexJsonl({ threadId: "thr-xyz", text: "done" }),
      exitCode: 0,
    });
    const { threads, executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { backend: "codex" },
    });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "t1" }] }));
    expect(threads.getCliSession(threadId)).toEqual({ backend: "codex", sessionId: "thr-xyz" });
    expect(fake.lastInput()?.command).toEqual(["codex", "exec", "--json", "-"]);

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "t2" }] }));
    expect(fake.lastInput()?.command).toEqual([
      "codex",
      "exec",
      "resume",
      "thr-xyz",
      "--json",
      "-",
    ]);
  });
});

describe("cli-dispatch — codex arm", () => {
  test("codex CREATE = ['codex','exec','--json','-'] with systemPrompt folded into stdin", async () => {
    const fake = makeFakeSpawner({
      stdout: codexJsonl({ threadId: "thr-1", text: "done" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { backend: "codex", promptBody: "be terse" },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    expect(fake.lastInput()?.command).toEqual(["codex", "exec", "--json", "-"]);
    // The fixed CLI preamble (P1.4) is folded ahead of the body, then the user msg.
    const stdin = fake.lastInput()?.stdin ?? "";
    expect(stdin.startsWith("BACKEND CONTEXT")).toBe(true);
    expect(stdin.endsWith("be terse\n\ngo")).toBe(true);
  });
});

// ─── P1: N3 skill-listing is gated to the NATIVE arm only ────────────────────
// The CLI path discloses its own skills over the projected `--add-dir`
// (ADR-0016); Hive runs no N3 disclosure there. So even when an Agent binds BOTH
// skills AND `load_skill`, the CLI's system prompt must be the authored
// `promptBody` ALONE — never an N3 "Available skills" listing that names a
// `load_skill` tool the CLI cannot call.
describe("cli-dispatch — N3 listing gated to native (P1)", () => {
  // A resolver that WOULD emit a listing if the CLI arm ever consulted it. The
  // test proves it does not.
  const listingResolver: SkillResolverPort = {
    list: () => [{ name: "research", description: "deep web research" }],
    load: () => undefined,
  };

  test("claude-code: system prompt is promptBody ALONE, no N3 listing even with load_skill bound", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      skillResolver: listingResolver,
      agent: {
        backend: "claude-code",
        bindings: { skills: ["research"], snippets: [], tools: ["load_skill"], mcp: [] },
        promptBody: "be terse",
      },
    });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));

    const cmd = fake.lastInput()?.command ?? [];
    const apsIdx = cmd.indexOf("--append-system-prompt");
    expect(apsIdx).toBeGreaterThan(-1);
    // promptBody rides through — preceded by the fixed CLI preamble (P1.4), and
    // ONLY promptBody after it (no N3 listing).
    const aps = cmd[apsIdx + 1] ?? "";
    expect(aps.endsWith("be terse")).toBe(true);
    // No N3 listing leaked: neither the "Available skills" header nor an
    // uncallable `load_skill` ADVERTISEMENT. The preamble names load_skill as
    // unavailable, so check the N3 listing phrase specifically, not the bare word.
    expect(aps).not.toContain("Available skills");
    expect(aps).not.toContain("call load_skill to load one");
    expect(aps).not.toContain("deep web research");
  });

  test("codex: stdin carries promptBody ALONE, no N3 listing even with load_skill bound", async () => {
    const fake = makeFakeSpawner({
      stdout: codexJsonl({ threadId: "thr-1", text: "done" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      skillResolver: listingResolver,
      agent: {
        backend: "codex",
        bindings: { skills: ["research"], snippets: [], tools: ["load_skill"], mcp: [] },
        promptBody: "be terse",
      },
    });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));

    // codex folds the system prompt into stdin: the fixed CLI preamble (P1.4) +
    // promptBody, then the user message. The N3 listing must not appear anywhere.
    const stdin = fake.lastInput()?.stdin ?? "";
    expect(stdin.endsWith("be terse\n\ngo")).toBe(true);
    expect(stdin.startsWith("BACKEND CONTEXT")).toBe(true);
    expect(stdin).not.toContain("Available skills");
    expect(stdin).not.toContain("call load_skill to load one");
  });
});

// ─── P1.1: resolved model/effort forwarded to claude (Q1) ─────────────────────
describe("cli-dispatch — model/effort forwarding (P1.1)", () => {
  test("anthropic model → --model with the BARE id (no provider/ prefix)", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "s1", text: "ok" }),
      exitCode: 0,
    });
    // Empty config → MODEL_FALLBACK (anthropic/claude-haiku-4-5).
    const { executor, threadId } = await setup({ cliSpawner: fake.spawner });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    const cmd = fake.lastInput()?.command ?? [];
    const mi = cmd.indexOf("--model");
    expect(mi).toBeGreaterThan(-1);
    expect(cmd[mi + 1]).toBe("claude-haiku-4-5");
    // No provider/ prefix leaked.
    expect(cmd.join(" ")).not.toContain("anthropic/");
  });

  test("non-anthropic configured model → NO --model", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "s1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { config: { model: "openai/gpt-5" } },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    expect(fake.lastInput()?.command).not.toContain("--model");
  });

  test("configured effort high → --effort high; off → no --effort", async () => {
    const fakeHigh = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "s1", text: "ok" }),
      exitCode: 0,
    });
    const high = await setup({
      cliSpawner: fakeHigh.spawner,
      agent: { config: { thinkingEffort: "high" } },
    });
    await collect(
      high.executor.startRun({
        threadId: high.threadId,
        userMessage: [{ type: "text", text: "hi" }],
      }),
    );
    const cmdH = fakeHigh.lastInput()?.command ?? [];
    const ei = cmdH.indexOf("--effort");
    expect(ei).toBeGreaterThan(-1);
    expect(cmdH[ei + 1]).toBe("high");

    const fakeOff = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "s1", text: "ok" }),
      exitCode: 0,
    });
    const off = await setup({
      cliSpawner: fakeOff.spawner,
      agent: { config: { thinkingEffort: "off" } },
    });
    await collect(
      off.executor.startRun({
        threadId: off.threadId,
        userMessage: [{ type: "text", text: "hi" }],
      }),
    );
    expect(fakeOff.lastInput()?.command).not.toContain("--effort");
  });
});

// ─── P1.2: permission contract forwarded to claude (Q2) ───────────────────────
describe("cli-dispatch — permission contract (P1.2)", () => {
  test("commandAllowlist [node] → --permission-mode default + Bash(node *) (load-bearing space)", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "s1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { commandAllowlist: ["node"] },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    const cmd = fake.lastInput()?.command ?? [];
    expect(cmd).toContain("--permission-mode");
    expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("default");
    expect(cmd).toContain("--allowedTools");
    expect(cmd).toContain("Bash(node *)");
    expect(cmd).not.toContain("Bash(node*)");
  });

  test("empty allowlist → --permission-mode default present, NO --allowedTools", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "s1", text: "ok" }),
      exitCode: 0,
    });
    // Default agent has no commandAllowlist.
    const { executor, threadId } = await setup({ cliSpawner: fake.spawner });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    const cmd = fake.lastInput()?.command ?? [];
    expect(cmd).toContain("--permission-mode");
    expect(cmd).not.toContain("--allowedTools");
  });

  test("codex gets neither --permission-mode nor --allowedTools (v1)", async () => {
    const fake = makeFakeSpawner({
      stdout: codexJsonl({ threadId: "t1", text: "done" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { backend: "codex", commandAllowlist: ["node"] },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    const cmd = fake.lastInput()?.command ?? [];
    expect(cmd).not.toContain("--permission-mode");
    expect(cmd).not.toContain("--allowedTools");
  });
});

// ─── P1.4: the fixed CLI preamble prepends the authored body (Q4) ─────────────
describe("cli-dispatch — CLI preamble (P1.4)", () => {
  test("claude --append-system-prompt BEGINS with the preamble, then the body", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "s1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { promptBody: "be terse" },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    const cmd = fake.lastInput()?.command ?? [];
    const apsIdx = cmd.indexOf("--append-system-prompt");
    expect(apsIdx).toBeGreaterThan(-1);
    const value = cmd[apsIdx + 1] ?? "";
    expect(value.startsWith("BACKEND CONTEXT")).toBe(true);
    expect(value).toContain("spawn_sub_agent");
    expect(value.endsWith("be terse")).toBe(true);
  });
});

// ─── P1.3: observed tool_use audit on the backend source (Q3) ─────────────────
describe("cli-dispatch — observed tool audit (P1.3)", () => {
  function claudeToolStream(opts: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    isError?: boolean;
  }): string[] {
    return [
      `${JSON.stringify({ type: "system", subtype: "init", session_id: opts.sessionId })}\n`,
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: opts.toolUseId,
              name: opts.toolName,
              input: { command: "SECRET-ARG" },
            },
          ],
        },
      })}\n`,
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: opts.toolUseId,
              content: "SECRET-OUTPUT",
              ...(opts.isError ? { is_error: true } : {}),
            },
          ],
        },
      })}\n`,
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      })}\n`,
      `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
    ];
  }

  test("a tool_use+tool_result pair → backend.tool_use.observed row carrying the tool NAME, no args", async () => {
    const { spawner } = makeFakeSpawner({
      stdout: claudeToolStream({ sessionId: "s1", toolUseId: "tu-1", toolName: "Bash" }),
      exitCode: 0,
    });
    const audit = makeAudit();
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const dispose = wireSubscriptions(audit, { backend: { events: executor.backendEvents } });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));

    const rows = await audit.query({ source: "backend" });
    const observed = rows.filter((r) => r.event_type === "backend.tool_use.observed");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payload.tool).toBe("Bash");
    expect(observed[0]?.payload.backend).toBe("claude-code");
    // A clean tool_result → is_error:false (P1.3 r1-design-2).
    expect(observed[0]?.payload.is_error).toBe(false);
    // Redaction: no command arg / output in the payload (ADR-0004 refs).
    expect(JSON.stringify(observed[0]?.payload)).not.toContain("SECRET-ARG");
    expect(JSON.stringify(observed[0]?.payload)).not.toContain("SECRET-OUTPUT");
    dispose();
  });

  test("an errored tool_result → backend.tool_use.observed row with is_error:true, no error content", async () => {
    const { spawner } = makeFakeSpawner({
      stdout: claudeToolStream({
        sessionId: "s1",
        toolUseId: "tu-2",
        toolName: "Bash",
        isError: true,
      }),
      exitCode: 0,
    });
    const audit = makeAudit();
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const dispose = wireSubscriptions(audit, { backend: { events: executor.backendEvents } });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));

    const rows = await audit.query({ source: "backend" });
    const observed = rows.filter((r) => r.event_type === "backend.tool_use.observed");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payload.tool).toBe("Bash");
    expect(observed[0]?.payload.is_error).toBe(true);
    // Redaction holds even on the error path (ADR-0004 refs — no error content).
    expect(JSON.stringify(observed[0]?.payload)).not.toContain("SECRET-OUTPUT");
    dispose();
  });

  test("an unknown stream event does NOT fail the Run (non-fatal)", async () => {
    const stdout = [
      `${JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })}\n`,
      `${JSON.stringify({ type: "some_future_event", data: { foo: 1 } })}\n`,
      "not json at all\n",
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      })}\n`,
      `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
    ];
    const { spawner } = makeFakeSpawner({ stdout, exitCode: 0 });
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    expect(events[events.length - 1]?.type).toBe("run.completed");
  });
});

describe("cli-dispatch — failure paths", () => {
  test("nonzero exit → run.failed with stderr tail folded into the message", async () => {
    const { spawner } = makeFakeSpawner({ stderr: ["boom\n"], exitCode: 1 });
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.failed");
    if (last?.type === "run.failed") {
      expect(last.error.code).toBe("backend_exited");
      expect(last.error.message).toContain("boom");
      expect(executor.getRun(last.runId)?.status).toBe("failed");
    }
  });

  test("stderr tail stays O(1): 1 MB stderr → folded tail is the LAST bytes, bounded", async () => {
    // 1 MB of 'a' then a recognizable final marker. The tail must contain the
    // marker (last bytes), not the leading bytes, and stay near TAIL_CAP.
    const big = "a".repeat(1024 * 1024);
    const { spawner } = makeFakeSpawner({ stderr: [big, "END-MARKER"], exitCode: 1 });
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.failed");
    if (last?.type === "run.failed") {
      expect(last.error.message).toContain("END-MARKER");
      // message = `claude exited 1:\n<tail>`; the tail is bounded to ~2048.
      expect(last.error.message.length).toBeLessThan(2048 + 64);
    }
  });

  test("spawn_failed → run.failed (backend_unavailable)", async () => {
    const { spawner } = makeFakeSpawner({ spawnFailed: "ENOENT: claude not found" });
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.failed");
    if (last?.type === "run.failed") {
      expect(last.error.code).toBe("backend_unavailable");
      expect(last.error.message).toContain("spawn failed");
      expect(executor.getRun(last.runId)?.status).toBe("failed");
    }
  });

  test("the disabled memoryCliSpawner → run.failed (spawn disabled)", async () => {
    const { executor, threadId } = await setup({ cliSpawner: memoryCliSpawner });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.failed");
    if (last?.type === "run.failed") expect(last.error.message).toContain("spawn disabled");
  });
});

describe("cli-dispatch — cancellation", () => {
  test("pre-aborted signal → run.cancelled + cancelled Run row", async () => {
    // Spawner that observes the (already-aborted) signal and ends streams; the
    // executor checks signal.aborted before treating exit as a failure.
    const spawner: CliSpawnerPort = {
      spawn(): CliSpawnResult {
        return {
          kind: "spawned",
          stdout: fromChunks([]),
          stderr: fromChunks([]),
          // A killed child exits nonzero — the abort check must win.
          exit: Promise.resolve({ exitCode: 137 }),
        };
      },
    };
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const stream = executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] });
    // Find the runId from run.started, then cancel before draining the rest.
    const events: RunEvent[] = [];
    for await (const ev of stream) {
      events.push(ev);
      if (ev.type === "run.started") executor.cancelRun(ev.runId);
    }
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.cancelled");
    if (last?.type === "run.cancelled") {
      expect(executor.getRun(last.runId)?.status).toBe("cancelled");
    }
  });
});

describe("cli-dispatch — backend audit (redacted)", () => {
  test("exactly one backend.spawn.requested row on source 'backend', redacted", async () => {
    const { spawner } = makeFakeSpawner({ stdout: ["hi"], exitCode: 0 });
    const audit = makeAudit();
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const dispose = wireSubscriptions(audit, { backend: { events: executor.backendEvents } });

    await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "SECRET-PROMPT" }] }),
    );

    expect(audit.subscriptions()).toContain("backend");
    const rows = await audit.query({ source: "backend" });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.event_type).toBe("backend.spawn.requested");
    expect(row?.payload.binary).toBe("claude");
    expect(typeof row?.payload.arg_count).toBe("number");
    expect(row?.payload.has_stdin).toBe(true);
    expect(row?.payload.backend).toBe("claude-code");
    // Redaction: the prompt, systemPrompt, and auth never enter the payload.
    expect(JSON.stringify(row?.payload)).not.toContain("SECRET-PROMPT");
    expect(JSON.stringify(row?.payload)).not.toContain("sk-test");

    dispose();
  });
});

// ─── C4: CLI spawn cwd resolution (same resolver as native) ──────────────────
// The CLI spawn cwd must come from the SAME three-tier resolver as native
// run_shell (ADR-0016 C4), so `claude --resume` stays cwd-stable across a
// Thread's Runs. Asserted via the fake spawner's recorded `cwd`.
describe("cli-dispatch — C4 Working Directory (spawn cwd)", () => {
  test("no thread/agent default → spawn cwd is the tier-3 per-Agent workspace", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({ cliSpawner: fake.spawner });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    expect(fake.lastInput()?.cwd).toBe(join(runtimeRoot(), "agents", "test-agent", "workspace"));
  });

  test("agent config.workingDir (tier 2) drives the spawn cwd", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { config: { workingDir: "/agent/default/dir" } },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    expect(fake.lastInput()?.cwd).toBe("/agent/default/dir");
  });

  test("Thread workingDir (tier 1) wins; resume reuses the SAME cwd across turns", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-abc", text: "first" }),
      exitCode: 0,
    });
    const { threads, executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { config: { workingDir: "/agent/default/dir" } },
    });
    await threads.setScope(threadId, { workingDir: "/thread/pick" });

    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "t1" }] }));
    const cwd1 = fake.lastInput()?.cwd;
    expect(cwd1).toBe("/thread/pick");

    // Turn 2 RESUMEs — the cwd must be identical (claude --resume is cwd-scoped).
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "t2" }] }));
    expect(fake.lastInput()?.command).toContain("--resume");
    expect(fake.lastInput()?.cwd).toBe(cwd1);
  });
});

// ─── C3: CLI skill projection (--add-dir) ─────────────────────────────────────

describe("cli-dispatch — skill projection (C3)", () => {
  // A real-fs harness: a temp runtimeRoot + a temp bundled skill dir, the real
  // copy edge. Proves the projected SKILL.md actually lands and --add-dir is
  // passed. Env + dirs are restored/removed per test.
  function withTempRoots(): {
    runtimeRoot: string;
    skillSrcDir: string;
    skillMdPath: string;
    cleanup: () => void;
  } {
    const base = mkdtempSync(join(tmpdir(), "hive-c3-"));
    const prevRoot = process.env.HIVE_RUNTIME_ROOT;
    const runtimeRootDir = join(base, "runtime");
    process.env.HIVE_RUNTIME_ROOT = runtimeRootDir;

    // A bundled skill dir with a SKILL.md (+ a supporting file to prove the
    // whole DIR is copied, not just the manifest).
    const skillSrcDir = join(base, "bundled", "skills", "research");
    const skillMdPath = join(skillSrcDir, "SKILL.md");
    mkdirSync(skillSrcDir, { recursive: true });
    writeFileSync(skillMdPath, "# Research skill\n");
    writeFileSync(join(skillSrcDir, "helper.md"), "supporting file\n");

    return {
      runtimeRoot: runtimeRootDir,
      skillSrcDir,
      skillMdPath,
      cleanup: () => {
        if (prevRoot === undefined) delete process.env.HIVE_RUNTIME_ROOT;
        else process.env.HIVE_RUNTIME_ROOT = prevRoot;
        rmSync(base, { recursive: true, force: true });
      },
    };
  }

  function projectionFor(skills: ProjectableSkill[]): SkillProjectionPort {
    return { resolve: (names) => skills.filter((s) => names.includes(s.name)) };
  }

  test("bound resolvable skill → --add-dir + projected SKILL.md lands; prompt still rides --append-system-prompt", async () => {
    const t = withTempRoots();
    try {
      const fake = makeFakeSpawner({
        stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
        exitCode: 0,
      });
      const projection = projectionFor([
        { name: "research", path: t.skillMdPath, origin: "personal" },
      ]);
      // Spy the copy so we can assert the projected SKILL.md actually landed at
      // spawn time, before the post-finalize best-effort cleanup removes it.
      const realCopy = createDefaultFsCopy();
      let landedSkillMd = false;
      let landedHelper = false;
      const fsCopy: FsCopyPort = {
        copy: async (src, dest) => {
          await realCopy.copy(src, dest);
          landedSkillMd ||= existsSync(join(dest, "SKILL.md"));
          landedHelper ||= existsSync(join(dest, "helper.md"));
        },
        remove: realCopy.remove,
      };
      const { executor, threadId } = await setup({
        cliSpawner: fake.spawner,
        fsCopy,
        skillProjection: projection,
        agent: {
          bindings: { skills: ["research"], snippets: [], tools: [], mcp: [] },
          promptBody: "be terse",
        },
      });

      await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));

      const cmd = fake.lastInput()?.command ?? [];
      const runId = executor.listByThread(threadId)[0]?.id ?? "";
      const projectionRoot = runtime.projectedCliRoot("test-agent", runId);
      // --add-dir present, pointing at the per-Run projection root.
      const addDirIdx = cmd.indexOf("--add-dir");
      expect(addDirIdx).toBeGreaterThan(-1);
      expect(cmd[addDirIdx + 1]).toBe(projectionRoot);
      // The authored prompt still rides --append-system-prompt (unchanged by C3),
      // now preceded by the fixed CLI preamble (P1.4).
      const apsIdx = cmd.indexOf("--append-system-prompt");
      expect(apsIdx).toBeGreaterThan(-1);
      expect(cmd[apsIdx + 1]?.endsWith("be terse")).toBe(true);

      // The whole skill DIR (SKILL.md + supporting file) landed under
      // .claude/skills/<name>, and the projection root is outside the cwd.
      expect(landedSkillMd).toBe(true);
      expect(landedHelper).toBe(true);
      expect(projectionRoot.startsWith(runtime.agent("test-agent"))).toBe(true);
      expect(projectionRoot.includes("cli-projection")).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("unresolvable binding (absent from projection) → NO --add-dir, Run still completes", async () => {
    const t = withTempRoots();
    try {
      const fake = makeFakeSpawner({
        stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
        exitCode: 0,
      });
      // The resolver returns nothing for "ghost" — a stale binding.
      const projection = projectionFor([]);
      const { executor, threadId } = await setup({
        cliSpawner: fake.spawner,
        fsCopy: createDefaultFsCopy(),
        skillProjection: projection,
        agent: { bindings: { skills: ["ghost"], snippets: [], tools: [], mcp: [] } },
      });

      const events = await collect(
        executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
      );
      const last = events[events.length - 1];
      expect(last?.type).toBe("run.completed");
      expect(fake.lastInput()?.command).not.toContain("--add-dir");
    } finally {
      t.cleanup();
    }
  });

  test("no skillProjection wired → no --add-dir even with bound skills", async () => {
    const fake = makeFakeSpawner({
      stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
      exitCode: 0,
    });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { bindings: { skills: ["research"], snippets: [], tools: [], mcp: [] } },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    expect(fake.lastInput()?.command).not.toContain("--add-dir");
  });

  test("per-Run projection dir is removed after the Run (best-effort cleanup)", async () => {
    const t = withTempRoots();
    try {
      const fake = makeFakeSpawner({
        stdout: claudeStreamJsonl({ sessionId: "sess-1", text: "ok" }),
        exitCode: 0,
      });
      const removed: string[] = [];
      // Real copy so the dir is created; spy remove so we assert it's targeted.
      const realCopy = createDefaultFsCopy();
      const fsCopy: FsCopyPort = {
        copy: realCopy.copy,
        remove: async (target) => {
          removed.push(target);
          await realCopy.remove(target);
        },
      };
      const projection = projectionFor([
        { name: "research", path: t.skillMdPath, origin: "personal" },
      ]);
      const { executor, threadId } = await setup({
        cliSpawner: fake.spawner,
        fsCopy,
        skillProjection: projection,
        agent: { bindings: { skills: ["research"], snippets: [], tools: [], mcp: [] } },
      });

      await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
      const runId = executor.listByThread(threadId)[0]?.id ?? "";
      const projectionRoot = runtime.projectedCliRoot("test-agent", runId);

      expect(removed).toContain(projectionRoot);
      // The remove is fire-and-forget after finalize; poll until the real rm
      // completes (best-effort cleanup is not awaited by the executor).
      for (let i = 0; i < 50 && existsSync(projectionRoot); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(existsSync(projectionRoot)).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});
