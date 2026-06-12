// C2b cli-dispatch-arm: the claude-code/codex backend dispatch through the
// CliSpawnerPort. Streamed stdout → Thread assistant message + run.completed;
// nonzero exit → run.failed with the stderr tail; abort → run.cancelled;
// spawn_failed → run.failed; redacted `backend` audit row.

import { afterEach, describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { AuditLive, type AuditSvc, Audit as AuditTag } from "../../audit/effect/audit-live.ts";
import { wireSubscriptions } from "../../audit/subscriptions.ts";
import type { Agent, Catalog } from "../../catalog/index.ts";
import { openHiveDb } from "../../db/hive-db.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { createGateway, type ModelGateway } from "../../model-gateway/index.ts";
import {
  SecretsLive,
  type SecretsSvc,
  Secrets as SecretsTag,
} from "../../secrets/effect/secrets-live.ts";
import { createThreadsStore } from "../../threads/store.ts";
import type { CliSpawnerPort, CliSpawnInput, CliSpawnResult } from "../effect/ports.ts";
import { createRunExecutor, type RunExecutor } from "../executor.ts";
import { createRunsStore } from "../store.ts";
import { memoryCliSpawner } from "../tools/cli-spawn.ts";
import type { RunEvent } from "../types.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "test-agent",
    backend: "claude-code",
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
    // biome-ignore lint/suspicious/noExplicitAny: stub event emitter; executor doesn't read catalog events.
    events: events as any,
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
  });
  const threadId = threads.create({ agentId: agent.agentId }).id;
  return { threads, executor, threadId };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cli-dispatch — happy path", () => {
  test("streamed stdout → assistant message + run.completed + completed Run row", async () => {
    const { spawner } = makeFakeSpawner({ stdout: ["hel", "lo"], exitCode: 0 });
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

  test("the spawner is reached (not the old emitFailed arm)", async () => {
    const fake = makeFakeSpawner({ stdout: ["ok"], exitCode: 0 });
    const { executor, threadId } = await setup({ cliSpawner: fake.spawner });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    expect(fake.lastInput()?.command).toEqual(["claude", "-p"]);
    expect(fake.lastInput()?.stdin).toBe("hi");
  });

  test("empty stdout → '[no output]' assistant message", async () => {
    const { spawner } = makeFakeSpawner({ stdout: [], exitCode: 0 });
    const { threads, executor, threadId } = await setup({ cliSpawner: spawner });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }));
    const assistant = threads.listMessages(threadId).find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "[no output]" }]);
  });
});

describe("cli-dispatch — codex arm", () => {
  test("codex invocation = ['codex','exec','-'] with systemPrompt folded into stdin", async () => {
    const fake = makeFakeSpawner({ stdout: ["done"], exitCode: 0 });
    const { executor, threadId } = await setup({
      cliSpawner: fake.spawner,
      agent: { backend: "codex", promptBody: "be terse" },
    });
    await collect(executor.startRun({ threadId, userMessage: [{ type: "text", text: "go" }] }));
    expect(fake.lastInput()?.command).toEqual(["codex", "exec", "-"]);
    expect(fake.lastInput()?.stdin).toBe("be terse\n\ngo");
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
      expect(last.error.code).toBe("invalid_request");
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

  test("spawn_failed → run.failed (invalid_request)", async () => {
    const { spawner } = makeFakeSpawner({ spawnFailed: "ENOENT: claude not found" });
    const { executor, threadId } = await setup({ cliSpawner: spawner });
    const events = await collect(
      executor.startRun({ threadId, userMessage: [{ type: "text", text: "hi" }] }),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.failed");
    if (last?.type === "run.failed") {
      expect(last.error.code).toBe("invalid_request");
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
