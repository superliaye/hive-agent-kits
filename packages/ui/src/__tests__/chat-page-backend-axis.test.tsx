// ChatPage backend×model axis (ADR-0015 + ADR-0018):
//   - the composer renders a backend picker (with versions) for EVERY agent
//     (the Agent-Manager native-lock is enforced by the daemon, not UI hiding);
//   - picking a backend issues PUT /api/threads/:id/scope { backend };
//   - a stored Thread backend scope survives a reload (scope-load reads it back);
//   - the apply-to-default control surfaces when the pick differs from the agent
//     default and issues PUT /api/agents/:id/model-pref { backend }.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { ChatPage } from "../pages/ChatPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

type Body = Record<string, unknown>;
let writes: Array<{ method: string; path: string; body: Body }>;
// The stored scope backend the daemon would echo.
let scopeBackend: string | null;
// Model/effort apply-to-default fixtures (P4). When set, the daemon echoes them
// as the Thread scope and offers a matching model in /api/models.
let scopeModel: string | null = null;
let scopeEffort: string | null = null;
let modelsFixture: unknown[] = [];
// The agent's harness config the daemon echoes from GET /api/agents/:id. A
// symbolic default ("latest"/"highest") lives here (it is not a saved pref).
let agentConfig: Record<string, unknown> = {};

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installStubs(): void {
  writes = [];
  (globalThis as { EventSource?: unknown }).EventSource = class {
    addEventListener(): void {}
    close(): void {}
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : {};
    if (method !== "GET") writes.push({ method, path, body });
    const parts = path.split("/").filter(Boolean);

    if (method === "GET" && path === "/api/threads") {
      return json([
        {
          id: "t1",
          agentId: "worker",
          createdAt: 1,
          updatedAt: 1,
          title: null,
          titleSource: "auto",
          archivedAt: null,
          status: "idle",
        },
      ]);
    }
    if (method === "GET" && parts.length === 3 && parts[1] === "threads") {
      return json({
        id: "t1",
        agentId: "worker",
        createdAt: 1,
        updatedAt: 1,
        title: null,
        titleSource: "auto",
        archivedAt: null,
        status: "idle",
        messages: [],
      });
    }
    if (method === "GET" && path === "/api/models") return json(modelsFixture);
    if (method === "GET" && path === "/api/backends") {
      return json([
        { backend: "claude-code", installed: true, version: "2.0.13", reason: "ok", checkedAt: 1 },
        { backend: "codex", installed: false, version: null, reason: "not_installed", checkedAt: 1 },
      ]);
    }
    if (method === "GET" && path.endsWith("/scope")) {
      return json({
        model: scopeModel,
        effort: scopeEffort,
        workingDir: null,
        backend: scopeBackend,
      });
    }
    if (method === "GET" && path.endsWith("/model-pref")) {
      return json({ model: null, effort: null, backend: null });
    }
    if (method === "PUT" && path.endsWith("/scope")) {
      return json({ model: null, effort: null, workingDir: null, backend: body.backend ?? null });
    }
    if (method === "PUT" && path.endsWith("/model-pref")) {
      return json({
        model: body.model ?? null,
        effort: body.effort ?? null,
        backend: body.backend ?? null,
      });
    }
    if (method === "GET" && parts[1] === "agents") {
      return json({
        agentId: "worker",
        // The harness default backend — kept DISTINCT from the "claude-code" pick
        // the apply-to-default tests use, so the pick differs from the default.
        backend: "codex",
        config: agentConfig,
      });
    }
    return json({});
  }) as typeof fetch;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let activeRoot: Root | null = null;
const apiConfig = { baseUrl: "http://localhost", token: "test-token" };

async function render(): Promise<HTMLElement> {
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;
  await act(async () => {
    root.render(createElement(ChatPage, { apiConfig, onNavigateToSecrets: () => {} }));
  });
  await flush();
  return host;
}

beforeAll(() => setupDom());
afterAll(() => teardownDom());
afterEach(async () => {
  if (activeRoot) {
    const r = activeRoot;
    await act(async () => {
      r.unmount();
    });
    activeRoot = null;
  }
  // Reset the optional fixtures so they don't leak between tests.
  scopeModel = null;
  scopeEffort = null;
  modelsFixture = [];
  agentConfig = {};
});

describe("ChatPage — Agent-Backend axis", () => {
  test("composer shows a backend picker listing available backends with versions", async () => {
    scopeBackend = null;
    installStubs();
    const host = await render();
    const picker = host.querySelector('[data-testid="composer-backend-picker"]');
    expect(picker).not.toBeNull();
    // claude-code (installed) shows its version; codex (not installed) is NOT
    // offered. (ADR-0019 dropped the synthetic native backend.)
    expect(picker?.textContent).toContain("claude-code 2.0.13");
    expect(picker?.textContent ?? "").not.toContain("codex");
  });

  test("the backend picker shows for EVERY agent (ADR-0018 — no UI Worker gate)", async () => {
    // No isWorker flag is sent by the daemon anymore; the picker always renders.
    // The Agent-Manager native-lock is enforced by the daemon scope-write (409),
    // not by hiding the picker.
    scopeBackend = null;
    installStubs();
    const host = await render();
    expect(host.querySelector('[data-testid="composer-backend-picker"]')).not.toBeNull();
  });

  test("picking a backend writes Thread scope; a stored pick survives reload", async () => {
    scopeBackend = null;
    installStubs();
    const host = await render();
    const picker = host.querySelector('[data-testid="composer-backend-picker"]') as
      | HTMLSelectElement
      | null;
    expect(picker).not.toBeNull();
    if (picker) {
      picker.value = "claude-code";
      await act(async () => {
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
    }
    const scopeWrite = writes.find((w) => w.method === "PUT" && w.path.endsWith("/scope"));
    expect(scopeWrite?.body).toMatchObject({ backend: "claude-code" });

    // Reload with the daemon now echoing the stored scope → the picker reflects it.
    await act(async () => {
      activeRoot?.unmount();
    });
    activeRoot = null;
    scopeBackend = "claude-code";
    installStubs();
    const host2 = await render();
    const picker2 = host2.querySelector('[data-testid="composer-backend-picker"]') as
      | HTMLSelectElement
      | null;
    expect(picker2?.value).toBe("claude-code");
  });

  test("apply-model-to-default surfaces when the model pick differs and writes the agent default (P4)", async () => {    scopeBackend = null;
    scopeModel = "openai/gpt-5"; // a runnable model, differs from the (null) default
    modelsFixture = [{ provider: "openai", modelId: "gpt-5", model: "openai/gpt-5", efforts: ["off"] }];
    installStubs();
    const host = await render();
    const apply = host.querySelector('[data-testid="apply-model-default"]');
    expect(apply).not.toBeNull();
    await act(async () => {
      apply?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const prefWrite = writes.find((w) => w.method === "PUT" && w.path.endsWith("/model-pref"));
    expect(prefWrite?.body).toMatchObject({ model: "openai/gpt-5" });
  });

  test("apply-effort-to-default surfaces when the effort pick differs and writes the agent default (P4)", async () => {    scopeBackend = null;
    scopeModel = "openai/gpt-5";
    scopeEffort = "high";
    modelsFixture = [
      { provider: "openai", modelId: "gpt-5", model: "openai/gpt-5", efforts: ["low", "high"] },
    ];
    installStubs();
    const host = await render();
    const apply = host.querySelector('[data-testid="apply-effort-default"]');
    expect(apply).not.toBeNull();
    await act(async () => {
      apply?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const prefWrite = writes.find((w) => w.method === "PUT" && w.path.endsWith("/model-pref"));
    expect(prefWrite?.body).toMatchObject({ effort: "high" });
  });

  test("apply-to-default surfaces when the pick differs and writes the agent default (OQ-2)", async () => {    scopeBackend = "claude-code"; // pick differs from the agent default
    installStubs();
    const host = await render();
    const apply = host.querySelector('[data-testid="apply-backend-default"]');
    expect(apply).not.toBeNull();
    await act(async () => {
      apply?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const prefWrite = writes.find((w) => w.method === "PUT" && w.path.endsWith("/model-pref"));
    expect(prefWrite?.body).toMatchObject({ backend: "claude-code" });
  });

  test("apply rows are grouped, named per axis, and the button reads Update (P8/P9)", async () => {    scopeBackend = "claude-code"; // backend pick differs from the agent default
    scopeModel = "openai/gpt-5"; // model pick differs from the (null) default
    scopeEffort = "high"; // effort pick differs from the (null) default
    modelsFixture = [
      { provider: "openai", modelId: "gpt-5", model: "openai/gpt-5", efforts: ["low", "high"] },
    ];
    installStubs();
    const host = await render();
    // All three rows live inside ONE bounded group (P9).
    const group = host.querySelector(".composer-apply-default-group");
    expect(group).not.toBeNull();
    expect(group?.querySelectorAll(".composer-apply-default").length).toBe(3);
    // Standardized copy: each row names its axis noun.
    expect(group?.textContent).toContain("uses model");
    expect(group?.textContent).toContain("uses effort");
    expect(group?.textContent).toContain("uses backend");
    // Buttons are demoted ghost "Update" (P9), not the old verbose labels.
    for (const id of ["apply-model-default", "apply-effort-default", "apply-backend-default"]) {
      const btn = host.querySelector(`[data-testid="${id}"]`);
      expect(btn?.textContent).toBe("Update");
      expect(btn?.className).toContain("ghost");
    }
  });

  test("fresh conversation with a symbolic agent default and no pick shows NO apply rows", async () => {    scopeBackend = null; // no per-conversation pick on any axis
    scopeModel = null;
    scopeEffort = null;
    // Symbolic agent default — resolves to the catalog head, but the user picked
    // nothing, so no apply-to-default affordance may render.
    agentConfig = { model: "latest", thinkingEffort: "highest" };
    modelsFixture = [
      { provider: "openai", modelId: "gpt-5", model: "openai/gpt-5", efforts: ["low", "high"] },
    ];
    installStubs();
    const host = await render();
    expect(host.querySelector('[data-testid="apply-model-default"]')).toBeNull();
    expect(host.querySelector('[data-testid="apply-effort-default"]')).toBeNull();
    expect(host.querySelector('[data-testid="apply-backend-default"]')).toBeNull();
    expect(host.querySelector(".composer-apply-default-group")).toBeNull();
  });

  test("symbolic 'latest' default renders as 'latest → <catalog head>' once a row surfaces", async () => {    scopeBackend = null;
    // Symbolic model default; user picks a DIFFERENT runnable model → the model
    // apply row surfaces and shows the resolved default in its label.
    agentConfig = { model: "latest" };
    scopeModel = "openai/gpt-4";
    modelsFixture = [
      { provider: "openai", modelId: "gpt-5", model: "openai/gpt-5", efforts: ["off"] },
      { provider: "openai", modelId: "gpt-4", model: "openai/gpt-4", efforts: ["off"] },
    ];
    installStubs();
    const host = await render();
    const apply = host.querySelector('[data-testid="apply-model-default"]');
    expect(apply).not.toBeNull();
    const row = apply?.closest(".composer-apply-default");
    // The catalog head (models[0]) is openai/gpt-5, so "latest" resolves to it.
    expect(row?.textContent).toContain("latest → openai/gpt-5");
  });
});
