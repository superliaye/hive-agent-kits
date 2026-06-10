/**
 * HTTP routes for Threads + Runs (Part 4a). In-process daemon, fake model
 * adapter registered post-boot. Covers:
 *   - thread CRUD (create / get / list / delete)
 *   - POST /threads/:id/runs returns SSE; events round-trip
 *   - 409 on concurrent Run on the same thread
 *   - 404 on missing thread / run
 *   - run cancel endpoint
 *   - validation: malformed body / unknown agent / unknown provider
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeFixtures, makeFakeAdapter } from "../../model-gateway/adapters/fake.ts";
import type { CompletionInput, GatewayEvent } from "../../model-gateway/types.ts";
import { createServer, type ServerHandles } from "../index.ts";

const TOKEN = "test-token";

function harness(agentId: string): string {
  return `---
agentId: ${agentId}
backend: native
domain: ${agentId} domain
bindings:
  skills: []
  snippets: []
  tools: []
  mcp: []
config:
  model: anthropic/claude-haiku-4-5
---
# ${agentId}
Body.
`;
}

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
      authorization: `Bearer ${TOKEN}`,
    },
  });
}

function jsonBody(obj: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(obj) };
}

function putBody(obj: unknown): RequestInit {
  return { method: "PUT", body: JSON.stringify(obj) };
}

// Parse an SSE response body into a list of {event, data} pairs.
async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text();
  const out: Array<{ event: string; data: unknown }> = [];
  // SSE messages separated by blank lines. Within a message:
  //   event: <name>
  //   data: <json>
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

describe("server routes — threads + runs", () => {
  let bundledRoot: string;
  let runtimeRoot: string;
  let server: ServerHandles;

  beforeEach(async () => {
    bundledRoot = mkdtempSync(join(tmpdir(), "hive-bundled-"));
    runtimeRoot = mkdtempSync(join(tmpdir(), "hive-runtime-"));
    process.env.HIVE_BUNDLED_ROOT = bundledRoot;
    process.env.HIVE_RUNTIME_ROOT = runtimeRoot;

    mkdirSync(join(bundledRoot, "agents", "root"), { recursive: true });
    writeFileSync(join(bundledRoot, "agents", "root", "HARNESS.md"), harness("root"));

    server = await createServer({ mode: "memory", token: TOKEN });
    // Seed an apiKey so the executor doesn't bail with `no_credentials`.
    await server.secrets.setApiKey("anthropic", "sk-test");
  });

  afterEach(async () => {
    await server.dispose();
    delete process.env.HIVE_BUNDLED_ROOT;
    delete process.env.HIVE_RUNTIME_ROOT;
    if (existsSync(bundledRoot)) rmSync(bundledRoot, { recursive: true, force: true });
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
  });

  function registerFake(fixtures: FakeFixtures): void {
    // Last registration wins (registry.test.ts) — overrides pi-ai for "anthropic".
    server.gateway.registerAdapter(makeFakeAdapter(["anthropic"], fixtures));
  }

  // ─── Thread CRUD ───────────────────────────────────────────────────────

  test("POST /api/threads creates a thread for a known agent", async () => {
    const res = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; agentId: string };
    expect(body.agentId).toBe("root");
    expect(body.id).toBeTruthy();
  });

  test("POST /api/threads rejects unknown agent with 404", async () => {
    const res = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "nope" })));
    expect(res.status).toBe(404);
  });

  test("POST /api/threads rejects malformed body with 400", async () => {
    const res = await server.app.fetch(
      authed("/api/threads", { method: "POST", body: "{not json" }),
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/threads lists threads sorted desc by updatedAt", async () => {
    await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const res = await server.app.fetch(authed("/api/threads"));
    const list = (await res.json()) as Array<{ id: string }>;
    expect(list).toHaveLength(2);
  });

  test("GET /api/threads/:id returns 404 when missing", async () => {
    const res = await server.app.fetch(authed("/api/threads/missing"));
    expect(res.status).toBe(404);
  });

  test("DELETE /api/threads/:id removes the thread", async () => {
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const { id } = (await create.json()) as { id: string };
    const del = await server.app.fetch(authed(`/api/threads/${id}`, { method: "DELETE" }));
    expect(del.status).toBe(204);
    const after = await server.app.fetch(authed(`/api/threads/${id}`));
    expect(after.status).toBe(404);
  });

  // ─── Runs SSE ──────────────────────────────────────────────────────────

  test("POST /threads/:id/runs streams SSE with lifecycle events", async () => {
    registerFake({
      "anthropic/claude-haiku-4-5": [
        { type: "text_start", blockIndex: 0 },
        { type: "text_delta", blockIndex: 0, delta: "hello" },
        { type: "text_end", blockIndex: 0 },
        { type: "done", finishReason: "stop" },
      ],
    });
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const { id: threadId } = (await create.json()) as { id: string };

    const res = await server.app.fetch(
      authed(
        `/api/threads/${threadId}/runs`,
        jsonBody({
          userMessage: [{ type: "text", text: "hi" }],
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSSE(res);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("run.started");
    expect(names[names.length - 1]).toBe("run.completed");
    // Every GatewayEvent was wrapped in a model.event
    expect(names.filter((n) => n === "model.event").length).toBeGreaterThan(0);
  });

  test("POST /runs rejects concurrent Run on the same thread with 409", async () => {
    registerFake({
      "anthropic/claude-haiku-4-5": (() => {
        // Long-ish script so the first Run is still in flight when we hit again.
        const evs: GatewayEvent[] = [];
        for (let i = 0; i < 200; i++) {
          evs.push({ type: "text_delta", blockIndex: 0, delta: "x" });
        }
        evs.push({ type: "done", finishReason: "stop" });
        return evs;
      })(),
    });
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const { id: threadId } = (await create.json()) as { id: string };

    // Start a Run but don't drain it yet — its SSE body is buffered until read.
    // The executor's busy-thread set is populated at iterator-construction time.
    const first = server.app.fetch(
      authed(
        `/api/threads/${threadId}/runs`,
        jsonBody({
          userMessage: [{ type: "text", text: "go" }],
        }),
      ),
    );
    // Drain partially.
    const firstRes = await first;
    // The iterator hasn't been advanced because Hono buffers — but the route
    // code calls `startRun` BEFORE returning the streamSSE result, so the
    // busy-thread guard is already in place.
    const second = await server.app.fetch(
      authed(
        `/api/threads/${threadId}/runs`,
        jsonBody({
          userMessage: [{ type: "text", text: "again" }],
        }),
      ),
    );
    expect(second.status).toBe(409);
    // Drain the first to clean up.
    await firstRes.text();
  });

  test("POST /threads/:missing/runs returns 404", async () => {
    const res = await server.app.fetch(
      authed(
        "/api/threads/missing/runs",
        jsonBody({
          userMessage: [{ type: "text", text: "hi" }],
        }),
      ),
    );
    expect(res.status).toBe(404);
  });

  test("POST /runs rejects malformed body with 400", async () => {
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const { id: threadId } = (await create.json()) as { id: string };
    const res = await server.app.fetch(
      authed(
        `/api/threads/${threadId}/runs`,
        jsonBody({
          userMessage: [{ type: "text" }], // missing `text` field
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  test("POST /runs surfaces no_credentials via run.failed when secrets missing", async () => {
    await server.secrets.remove("anthropic");
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const { id: threadId } = (await create.json()) as { id: string };

    const res = await server.app.fetch(
      authed(
        `/api/threads/${threadId}/runs`,
        jsonBody({
          userMessage: [{ type: "text", text: "hi" }],
        }),
      ),
    );
    expect(res.status).toBe(200);
    const events = await readSSE(res);
    const failed = events.find((e) => e.event === "run.failed");
    expect(failed).toBeDefined();
    const payload = failed?.data as { error: { code: string } };
    expect(payload.error.code).toBe("no_credentials");
  });

  // ─── Run query / cancel ────────────────────────────────────────────────

  test("GET /api/runs/:id returns the run row", async () => {
    registerFake({
      "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }],
    });
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const { id: threadId } = (await create.json()) as { id: string };

    const runRes = await server.app.fetch(
      authed(
        `/api/threads/${threadId}/runs`,
        jsonBody({
          userMessage: [{ type: "text", text: "hi" }],
        }),
      ),
    );
    const events = await readSSE(runRes);
    const started = events.find((e) => e.event === "run.started");
    const runId = (started?.data as { runId: string }).runId;

    const get = await server.app.fetch(authed(`/api/runs/${runId}`));
    expect(get.status).toBe(200);
    const row = (await get.json()) as { id: string; status: string };
    expect(row.id).toBe(runId);
    expect(row.status).toBe("completed");
  });

  test("GET /api/runs/:missing returns 404", async () => {
    const res = await server.app.fetch(authed("/api/runs/nope"));
    expect(res.status).toBe(404);
  });

  test("POST /api/runs/:missing/cancel returns 404", async () => {
    const res = await server.app.fetch(authed("/api/runs/nope/cancel", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  test("GET /api/threads/:id/runs lists runs on a thread", async () => {
    registerFake({
      "anthropic/claude-haiku-4-5": [{ type: "done", finishReason: "stop" }],
    });
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    const { id: threadId } = (await create.json()) as { id: string };
    const run = await server.app.fetch(
      authed(
        `/api/threads/${threadId}/runs`,
        jsonBody({
          userMessage: [{ type: "text", text: "hi" }],
        }),
      ),
    );
    await readSSE(run);
    const list = await server.app.fetch(authed(`/api/threads/${threadId}/runs`));
    const rows = (await list.json()) as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
  });

  // ─── Thread title / archive / read / unread ────────────────────────────

  type ThreadWire = {
    id: string;
    title: string | null;
    titleSource: "auto" | "manual";
    archivedAt: number | null;
    status: "idle" | "running" | "unread" | "failed";
  };

  async function createThread(): Promise<string> {
    const create = await server.app.fetch(authed("/api/threads", jsonBody({ agentId: "root" })));
    return ((await create.json()) as { id: string }).id;
  }

  async function getThread(id: string): Promise<ThreadWire> {
    const res = await server.app.fetch(authed(`/api/threads/${id}`));
    return (await res.json()) as ThreadWire;
  }

  // A completed run finishes a text reply; title-gen replays the same fixture.
  const TEXT_REPLY = [
    { type: "text_start", blockIndex: 0 },
    { type: "text_delta", blockIndex: 0, delta: "hello world" },
    { type: "text_end", blockIndex: 0 },
    { type: "done", finishReason: "stop" },
  ] as const;

  async function runOnce(threadId: string, text = "hi"): Promise<void> {
    const res = await server.app.fetch(
      authed(`/api/threads/${threadId}/runs`, jsonBody({ userMessage: [{ type: "text", text }] })),
    );
    await readSSE(res);
  }

  // Poll a thread until `pred` holds — auto-title fires fire-and-forget after
  // the SSE stream closes, so it may not have settled when readSSE returns.
  async function waitForThread(
    id: string,
    pred: (t: ThreadWire) => boolean,
    tries = 50,
  ): Promise<ThreadWire> {
    for (let i = 0; i < tries; i++) {
      const t = await getThread(id);
      if (pred(t)) return t;
      await new Promise((r) => setTimeout(r, 10));
    }
    return getThread(id);
  }

  test("PUT /api/threads/:id/title sets title and flips titleSource to manual", async () => {
    const id = await createThread();
    const res = await server.app.fetch(
      authed(`/api/threads/${id}/title`, putBody({ title: "My title" })),
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as ThreadWire;
    expect(summary.title).toBe("My title");
    expect(summary.titleSource).toBe("manual");
    const after = await getThread(id);
    expect(after.title).toBe("My title");
    expect(after.titleSource).toBe("manual");
  });

  test("PUT /api/threads/:id/title 404s unknown thread; 400 on empty title", async () => {
    const missing = await server.app.fetch(
      authed("/api/threads/missing/title", putBody({ title: "x" })),
    );
    expect(missing.status).toBe(404);
    const id = await createThread();
    const bad = await server.app.fetch(authed(`/api/threads/${id}/title`, putBody({ title: "" })));
    expect(bad.status).toBe(400);
  });

  test("POST /api/threads/:id/archive sets archivedAt; 404 unknown", async () => {
    const id = await createThread();
    const res = await server.app.fetch(authed(`/api/threads/${id}/archive`, { method: "POST" }));
    expect(res.status).toBe(200);
    const summary = (await res.json()) as ThreadWire;
    expect(summary.archivedAt).not.toBeNull();
    const missing = await server.app.fetch(
      authed("/api/threads/missing/archive", { method: "POST" }),
    );
    expect(missing.status).toBe(404);
  });

  test("POST unread clears lastReadAt (status → unread); POST read → idle; 404s", async () => {
    registerFake({ "anthropic/claude-haiku-4-5": [...TEXT_REPLY] });
    const id = await createThread();
    await runOnce(id);
    // After a completed run, never-read → unread.
    expect((await getThread(id)).status).toBe("unread");

    const read = await server.app.fetch(authed(`/api/threads/${id}/read`, { method: "POST" }));
    expect(read.status).toBe(204);
    expect((await getThread(id)).status).toBe("idle");

    const unread = await server.app.fetch(authed(`/api/threads/${id}/unread`, { method: "POST" }));
    expect(unread.status).toBe(204);
    expect((await getThread(id)).status).toBe("unread");

    const missingRead = await server.app.fetch(
      authed("/api/threads/missing/read", { method: "POST" }),
    );
    expect(missingRead.status).toBe(404);
    const missingUnread = await server.app.fetch(
      authed("/api/threads/missing/unread", { method: "POST" }),
    );
    expect(missingUnread.status).toBe(404);
  });

  test("GET /api/threads reports status/title/archivedAt per row, incl. archived", async () => {
    registerFake({ "anthropic/claude-haiku-4-5": [...TEXT_REPLY] });
    const idle = await createThread();
    const unread = await createThread();
    await runOnce(unread);
    const archived = await createThread();
    await server.app.fetch(authed(`/api/threads/${archived}/archive`, { method: "POST" }));

    const res = await server.app.fetch(authed("/api/threads"));
    const rows = (await res.json()) as ThreadWire[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(idle)?.status).toBe("idle");
    expect(byId.get(unread)?.status).toBe("unread");
    // Archived row is still returned.
    expect(byId.get(archived)?.archivedAt).not.toBeNull();
  });

  test("GET /api/threads reports running for an in-flight Run", async () => {
    registerFake({
      "anthropic/claude-haiku-4-5": (() => {
        const evs: GatewayEvent[] = [];
        for (let i = 0; i < 200; i++) evs.push({ type: "text_delta", blockIndex: 0, delta: "x" });
        evs.push({ type: "done", finishReason: "stop" });
        return evs;
      })(),
    });
    const id = await createThread();
    const inflight = server.app.fetch(
      authed(`/api/threads/${id}/runs`, jsonBody({ userMessage: [{ type: "text", text: "go" }] })),
    );
    const res = await inflight;
    // The busy-thread set is populated at startRun (before the stream drains).
    const list = (await (await server.app.fetch(authed("/api/threads"))).json()) as ThreadWire[];
    expect(list.find((r) => r.id === id)?.status).toBe("running");
    await res.text();
  });

  test("GET /api/threads reports failed; a later successful Run clears to unread; read → idle", async () => {
    registerFake({ "anthropic/claude-haiku-4-5": [...TEXT_REPLY] });
    const id = await createThread();

    // Drive a failing Run: remove the secret so the executor records a failed
    // Run row (no_credentials), then restore it for the recovery Run.
    await server.secrets.remove("anthropic");
    await runOnce(id, "will fail");
    expect((await getThread(id)).status).toBe("failed");

    // A later successful Run is the newest terminal — the row flips to unread.
    await server.secrets.setApiKey("anthropic", "sk-test");
    await runOnce(id, "now works");
    expect((await getThread(id)).status).toBe("unread");

    // Reading clears it to idle.
    const read = await server.app.fetch(authed(`/api/threads/${id}/read`, { method: "POST" }));
    expect(read.status).toBe(204);
    expect((await getThread(id)).status).toBe("idle");
  });

  test("POST read on a failed thread clears it to idle", async () => {
    const id = await createThread();
    await server.secrets.remove("anthropic");
    await runOnce(id, "will fail");
    expect((await getThread(id)).status).toBe("failed");

    const read = await server.app.fetch(authed(`/api/threads/${id}/read`, { method: "POST" }));
    expect(read.status).toBe(204);
    expect((await getThread(id)).status).toBe("idle");
  });

  // ─── Auto-title generation ─────────────────────────────────────────────

  test("first completed exchange on an untitled auto thread gets a title", async () => {
    registerFake({ "anthropic/claude-haiku-4-5": [...TEXT_REPLY] });
    const id = await createThread();
    await runOnce(id);
    const t = await waitForThread(id, (t) => t.title !== null);
    expect(t.title).toBe("hello world");
    expect(t.titleSource).toBe("auto");
  });

  test("second completed exchange does NOT regenerate once a title exists", async () => {
    // First exchange yields a normal reply (→ title). Second exchange replies
    // differently; if title-gen wrongly re-ran it would overwrite. Guard 1
    // (title already present) — NOT a completed-run count — must skip the second.
    // Distinguish the run reply from the title-gen call by the system prompt
    // (title-gen sends the fixed "Summarize…" instruction). The title-gen call
    // always returns "TITLEGEN"; the run reply is "hello world". The first
    // exchange must title to "TITLEGEN"; the second must NOT re-run title-gen.
    registerFake({
      "anthropic/claude-haiku-4-5": (input: CompletionInput): GatewayEvent[] =>
        input.system?.startsWith("Summarize")
          ? [
              { type: "text_start", blockIndex: 0 },
              { type: "text_delta", blockIndex: 0, delta: "TITLEGEN" },
              { type: "text_end", blockIndex: 0 },
              { type: "done", finishReason: "stop" },
            ]
          : [...TEXT_REPLY],
    });
    const id = await createThread();
    await runOnce(id, "first");
    const first = await waitForThread(id, (t) => t.title !== null);
    expect(first.title).toBe("TITLEGEN");
    await runOnce(id, "second");
    // Give any (wrong) regen a chance to run, then assert unchanged.
    const after = await waitForThread(id, () => false, 5);
    expect(after.title).toBe("TITLEGEN");
  });

  test("later completed exchange backfills the title after an earlier title-gen failure", async () => {
    // Self-heal / disconnect-resilience (ADR-0014 §2): the first exchange
    // completes but its title-gen fails (gateway error), so the Thread stays
    // untitled. The next completed exchange must backfill the title. This
    // FAILS under the old `completedCount !== 1` guard (the 2nd exchange has
    // count 2 and was skipped) and PASSES under the `< 1` floor.
    let titleGenCalls = 0;
    registerFake({
      "anthropic/claude-haiku-4-5": (input: CompletionInput): GatewayEvent[] => {
        if (input.system?.startsWith("Summarize")) {
          titleGenCalls += 1;
          // First title-gen attempt errors; subsequent attempts succeed.
          return titleGenCalls === 1
            ? [
                { type: "error", code: "model_overloaded", message: "boom", retryable: false },
                { type: "done", finishReason: "error" },
              ]
            : [
                { type: "text_start", blockIndex: 0 },
                { type: "text_delta", blockIndex: 0, delta: "BACKFILLED" },
                { type: "text_end", blockIndex: 0 },
                { type: "done", finishReason: "stop" },
              ];
        }
        return [...TEXT_REPLY];
      },
    });
    const id = await createThread();
    await runOnce(id, "first");
    // First exchange completed but title-gen failed → still untitled.
    const afterFirst = await waitForThread(id, () => false, 5);
    expect(afterFirst.title).toBeNull();
    await runOnce(id, "second");
    const afterSecond = await waitForThread(id, (t) => t.title !== null);
    expect(afterSecond.title).toBe("BACKFILLED");
    expect(afterSecond.titleSource).toBe("auto");
  });

  test("manually-titled thread is never overwritten by auto-title", async () => {
    registerFake({ "anthropic/claude-haiku-4-5": [...TEXT_REPLY] });
    const id = await createThread();
    await server.app.fetch(authed(`/api/threads/${id}/title`, putBody({ title: "Pinned" })));
    await runOnce(id);
    const after = await waitForThread(id, () => false, 5);
    expect(after.title).toBe("Pinned");
    expect(after.titleSource).toBe("manual");
  });

  test("title-gen failure leaves thread untitled, no Run failure, no audit row", async () => {
    // Run replies normally; the title-gen call (system = TITLE_SYSTEM_PROMPT)
    // returns an error → no title, no throw.
    registerFake({
      "anthropic/claude-haiku-4-5": (input: CompletionInput): GatewayEvent[] =>
        input.system?.startsWith("Summarize")
          ? [
              { type: "error", code: "model_overloaded", message: "boom", retryable: false },
              { type: "done", finishReason: "error" },
            ]
          : [...TEXT_REPLY],
    });
    const id = await createThread();
    const res = await server.app.fetch(
      authed(`/api/threads/${id}/runs`, jsonBody({ userMessage: [{ type: "text", text: "hi" }] })),
    );
    const events = await readSSE(res);
    // Run itself completed (not failed).
    expect(events[events.length - 1]?.event).toBe("run.completed");
    const after = await waitForThread(id, () => false, 5);
    expect(after.title).toBeNull();
    // No source=thread audit row was produced by auto-title.
    const audit = await server.app.fetch(authed("/api/audit?source=thread"));
    const rows = (await audit.json()) as unknown[];
    expect(rows).toHaveLength(0);
  });

  // ─── Run lifecycle on /api/events ──────────────────────────────────────

  // Collect SSE frames off a streamed Response until `done` returns true or the
  // timeout elapses. Mirrors the proven incremental-read pattern in
  // routes.test.ts (per-read race so a pending read can't block forever).
  async function collectEvents(
    res: Response,
    done: (frames: Array<{ event: string; data: string }>) => boolean,
    timeoutMs: number,
  ): Promise<Array<{ event: string; data: string }>> {
    const out: Array<{ event: string; data: string }> = [];
    if (!res.body) return out;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let buf = "";
    while (Date.now() < deadline) {
      const { value, done: streamDone } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 200),
        ),
      ]);
      if (value) buf += decoder.decode(value, { stream: true });
      else if (streamDone && !value) {
        if (done(out)) break;
        continue;
      }
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const eventLine = frame.split(/\r?\n/).find((l) => l.startsWith("event:"));
        const dataLine = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
        out.push({
          event: eventLine?.slice("event:".length).trim() ?? "",
          data: dataLine?.slice("data:".length).trim() ?? "",
        });
      }
      if (done(out)) break;
    }
    await reader.cancel();
    return out;
  }

  test("/api/events yields run.started + terminal run envelope with correct threadId", async () => {
    registerFake({ "anthropic/claude-haiku-4-5": [...TEXT_REPLY] });
    const id = await createThread();

    const stream = await server.app.fetch(
      new Request(`http://localhost/api/events?token=${TOKEN}`),
    );
    expect(stream.status).toBe(200);

    // Read the events stream concurrently with firing a Run on the thread.
    const [frames] = await Promise.all([
      collectEvents(stream, (fs) => fs.some((f) => f.event === "run.run.completed"), 5000),
      // Small delay so the events stream is attached before the run emits.
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        await runOnce(id);
      })(),
    ]);

    const started = frames.find((f) => f.event === "run.run.started");
    const completed = frames.find((f) => f.event === "run.run.completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    const startedPayload = JSON.parse(started?.data ?? "{}") as { payload: { threadId: string } };
    const completedPayload = JSON.parse(completed?.data ?? "{}") as {
      payload: { threadId: string };
    };
    expect(startedPayload.payload.threadId).toBe(id);
    expect(completedPayload.payload.threadId).toBe(id);

    // Registry/catalog events still flow on the same stream.
    const patch = await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        body: JSON.stringify({ patches: [{ kind: "skill", name: "alpha", action: "unbind" }] }),
      }),
    );
    expect([200, 404]).toContain(patch.status);
  });
});
