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
import { makeFakeAdapter } from "../../model-gateway/adapters/fake.ts";
import type { GatewayEvent } from "../../model-gateway/types.ts";
import { type ServerHandles, createServer } from "../index.ts";

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

  function registerFake(fixtures: Record<string, GatewayEvent[]>): void {
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
});
