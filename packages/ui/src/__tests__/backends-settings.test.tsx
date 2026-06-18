// BackendsSettings: one card per backend from GET /api/backends/readiness, with
// a Health zone and an Auth zone. The readiness badge is a UI-derived verdict
// (Ready / Using CLI sign-in / Action needed / Not installed / Error) from
// health + auth.state. "Using CLI sign-in" is the NEUTRAL cli-managed state;
// "Action needed" is reserved for an installed backend whose stored sign-in is
// EXPIRED. The Auth zone is driven by auth.state + auth.stored: api-key (Replace
// + Remove), cli-managed without stored (reassurance copy + a SECONDARY "Use an
// API key instead"), cli-managed with an OAuth token (CLI-sign-in copy + Remove +
// Set API key). When a backend is Not installed the auth setup is suppressed —
// only a leftover stored credential surfaces a single Remove. The allowlist lives
// in Permissions now, so its controls must be ABSENT here.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BackendReadiness } from "../api.ts";
import { BackendsSettings } from "../components/BackendsSettings.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let readinessSeq: BackendReadiness[][];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installStubs(): void {
  calls = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path, body });

    if (method === "GET" && path === "/api/backends/readiness") {
      const next = readinessSeq.length > 1 ? readinessSeq.shift() : readinessSeq[0];
      return json(next);
    }
    // setApiKey / removeSecret return 204 No Content.
    if (method === "POST" && path.endsWith("/api-key")) return new Response(null, { status: 204 });
    if (method === "DELETE" && path.startsWith("/api/secrets/")) {
      return new Response(null, { status: 204 });
    }
    return json({});
  }) as typeof fetch;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
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
    root.render(createElement(BackendsSettings, { apiConfig }));
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
});

// Counts FILLED primary buttons (class "button" without the "ghost" modifier)
// inside a card — the DP3 single-primary invariant.
function filledPrimaryCount(card: Element): number {
  let n = 0;
  for (const btn of card.querySelectorAll("button.button")) {
    if (!btn.classList.contains("ghost")) n++;
  }
  return n;
}

const claudeApiKey: BackendReadiness = {
  backend: "claude-code",
  installed: true,
  version: "2.0.13",
  reason: "ok",
  checkedAt: 1,
  provider: "anthropic",
  auth: { state: "api-key", stored: { kind: "apiKey", status: "ok", addedAt: 10 } },
};
const claudeCliManaged: BackendReadiness = {
  backend: "claude-code",
  installed: true,
  version: "2.0.13",
  reason: "ok",
  checkedAt: 1,
  provider: "anthropic",
  auth: { state: "cli-managed" },
};
const codexNotInstalled: BackendReadiness = {
  backend: "codex",
  installed: false,
  version: null,
  reason: "not_installed",
  checkedAt: 1,
  provider: "openai-codex",
  auth: { state: "cli-managed" },
};

describe("BackendsSettings", () => {
  test("renders one card per backend with health fields", async () => {
    installStubs();
    readinessSeq = [[claudeApiKey, codexNotInstalled]];
    const host = await render();
    expect(host.querySelector('[data-testid="backend-card-claude-code"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="backend-card-codex"]')).not.toBeNull();
    // Health fields render.
    expect(host.querySelector('[data-testid="backend-health-claude-code"]')).not.toBeNull();
    expect(host.textContent).toContain("2.0.13");
    expect(host.querySelector('[data-testid="backend-update-claude-code"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="backend-recheck-claude-code"]')).not.toBeNull();
    // not_installed codex shows install guidance, no Update.
    expect(host.querySelector('[data-testid="backend-install-codex"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="backend-update-codex"]')).toBeNull();
  });

  test("card titles use friendly names, not raw ids as the heading", async () => {
    installStubs();
    readinessSeq = [[claudeApiKey, codexNotInstalled]];
    const host = await render();
    expect(host.textContent).toContain("Claude Code");
    expect(host.textContent).toContain("Codex");
    // No user-facing jargon anywhere on the page.
    expect(host.textContent).not.toContain("openai-codex".toUpperCase());
    expect(host.textContent).not.toContain("delegated updates");
    expect(host.textContent).not.toContain("ambient login");
    expect(host.textContent?.toLowerCase()).not.toContain("provider's models runnable");
  });

  test("readiness badge: api-key → Ready", async () => {
    installStubs();
    readinessSeq = [[claudeApiKey]];
    const host = await render();
    const badge = host.querySelector('[data-testid="backend-readiness-claude-code"]');
    expect(badge?.textContent).toContain("Ready");
    expect(badge?.textContent).not.toContain("Action needed");
  });

  test("readiness badge: installed + cli-managed (no key) → neutral 'Using CLI sign-in', not an alarm", async () => {
    installStubs();
    readinessSeq = [[claudeCliManaged]];
    const host = await render();
    const badge = host.querySelector('[data-testid="backend-readiness-claude-code"]');
    expect(badge?.textContent).toContain("Using CLI sign-in");
    // A logged-in user must NOT be told "Action needed" — that manufactured a blocker.
    expect(badge?.textContent).not.toContain("Action needed");
  });

  test("readiness badge: installed + EXPIRED stored sign-in → Action needed", async () => {
    installStubs();
    const claudeExpired: BackendReadiness = {
      backend: "claude-code",
      installed: true,
      version: "2.0.13",
      reason: "ok",
      checkedAt: 1,
      provider: "anthropic",
      auth: { state: "cli-managed", stored: { kind: "oauth", status: "expired", addedAt: 10 } },
    };
    readinessSeq = [[claudeExpired]];
    const host = await render();
    const badge = host.querySelector('[data-testid="backend-readiness-claude-code"]');
    expect(badge?.textContent).toContain("Action needed");
  });

  test("readiness badge: not installed → Not installed", async () => {
    installStubs();
    readinessSeq = [[codexNotInstalled]];
    const host = await render();
    const badge = host.querySelector('[data-testid="backend-readiness-codex"]');
    expect(badge?.textContent).toContain("Not installed");
  });

  test("readiness badge: installed probe failure → Error", async () => {
    installStubs();
    const probeFailed: BackendReadiness = {
      backend: "claude-code",
      installed: true,
      version: null,
      reason: "probe_failed",
      checkedAt: 1,
      provider: "anthropic",
      auth: { state: "cli-managed" },
    };
    readinessSeq = [[probeFailed]];
    const host = await render();
    const badge = host.querySelector('[data-testid="backend-readiness-claude-code"]');
    expect(badge?.textContent).toContain("Error");
  });

  test("readiness badge: installed + version_unreadable is usable, NOT 'Error'", async () => {
    installStubs();
    // The binary ran cleanly; only its --version output didn't parse. A working
    // CLI must not be presented as broken — it derives from auth like any usable
    // backend (here cli-managed → neutral), with the version shown as "—".
    const unreadable: BackendReadiness = {
      backend: "claude-code",
      installed: true,
      version: null,
      reason: "version_unreadable",
      checkedAt: 1,
      provider: "anthropic",
      auth: { state: "cli-managed" },
    };
    readinessSeq = [[unreadable]];
    const host = await render();
    const badge = host.querySelector('[data-testid="backend-readiness-claude-code"]');
    expect(badge?.textContent).toContain("Using CLI sign-in");
    expect(badge?.textContent).not.toContain("Error");
  });

  test("common auth states carry no pushy filled primary; Set API key is a secondary affordance", async () => {
    installStubs();
    const codexCliManaged: BackendReadiness = {
      backend: "codex",
      installed: true,
      version: "0.5.0",
      reason: "ok",
      checkedAt: 1,
      provider: "openai-codex",
      auth: { state: "cli-managed" },
    };
    readinessSeq = [[claudeApiKey, codexCliManaged]];
    const host = await render();
    // Global invariant: never more than one filled primary per card.
    for (const card of host.querySelectorAll(".backend-card")) {
      expect(filledPrimaryCount(card)).toBeLessThanOrEqual(1);
    }
    // Reassurance-first: neither the api-key card nor the cli-managed card pushes
    // a filled primary. The cli-managed API-key path is a demoted secondary link,
    // so a logged-in user isn't pressured toward an unnecessary key.
    const apiKeyCard = host.querySelector('[data-testid="backend-card-claude-code"]');
    const cliCard = host.querySelector('[data-testid="backend-card-codex"]');
    expect(apiKeyCard).not.toBeNull();
    expect(cliCard).not.toBeNull();
    if (apiKeyCard) expect(filledPrimaryCount(apiKeyCard)).toBe(0);
    if (cliCard) expect(filledPrimaryCount(cliCard)).toBe(0);
    const setKey = host.querySelector('[data-testid="backend-auth-setkey-codex"]');
    expect(setKey?.classList.contains("ghost")).toBe(true);
  });

  test("repeated per-card buttons carry a backend-scoped aria-label", async () => {
    installStubs();
    readinessSeq = [[claudeApiKey]];
    const host = await render();
    const recheck = host.querySelector('[data-testid="backend-recheck-claude-code"]');
    expect(recheck?.getAttribute("aria-label")).toContain("Claude Code");
    const update = host.querySelector('[data-testid="backend-update-claude-code"]');
    expect(update?.getAttribute("aria-label")).toContain("Claude Code");
  });

  test("api-key row shows Replace + Remove; Remove DELETEs /api/secrets/{provider}", async () => {
    installStubs();
    readinessSeq = [[claudeApiKey]];
    const host = await render();
    expect(host.querySelector('[data-testid="backend-auth-replace-claude-code"]')).not.toBeNull();
    const remove = host.querySelector('[data-testid="backend-auth-remove-claude-code"]');
    expect(remove).not.toBeNull();
    await act(async () => {
      remove?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const del = calls.find((c) => c.method === "DELETE" && c.path === "/api/secrets/anthropic");
    expect(del).toBeDefined();
  });

  test("cli-managed (no stored) shows reassurance-first copy + secondary 'Use an API key instead'; submit POSTs the row's provider", async () => {
    installStubs();
    const codexCliManaged: BackendReadiness = {
      backend: "codex",
      installed: true,
      version: "0.5.0",
      reason: "ok",
      checkedAt: 1,
      provider: "openai-codex",
      auth: { state: "cli-managed" },
    };
    readinessSeq = [[codexCliManaged]];
    const host = await render();
    const cli = host.querySelector('[data-testid="backend-auth-cli-codex"]');
    expect(cli).not.toBeNull();
    // Reassurance-first: leads with "Hive uses your CLI sign-in", and is honest
    // that Hive can't verify it — does NOT claim a problem or demand a key.
    expect(cli?.textContent).toContain("CLI sign-in");
    expect(cli?.textContent).toContain("can't read your CLI login");
    expect(cli?.textContent).not.toContain("Action needed");

    const setKey = host.querySelector('[data-testid="backend-auth-setkey-codex"]');
    // The API-key path is a SECONDARY affordance — the recommended path is the
    // user's existing CLI sign-in, so this must not be a filled primary.
    expect(setKey?.classList.contains("ghost")).toBe(true);
    await act(async () => {
      setKey?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const input = host.querySelector(
      '[data-testid="backend-key-value-codex"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // No free-text provider input — only the key value field.
    const form = host.querySelector('[data-testid="backend-key-form-codex"]');
    expect(form?.querySelector('[data-testid="api-key-provider"]')).toBeNull();

    // The form reads the key from the (uncontrolled) input on submit.
    if (input) input.value = "sk-test";
    const formToSubmit = host.querySelector('[data-testid="backend-key-form-codex"]');
    await act(async () => {
      formToSubmit?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    // Locks the map: codex writes openai-codex, never "openai".
    const post = calls.find(
      (c) => c.method === "POST" && c.path === "/api/secrets/openai-codex/api-key",
    );
    expect(post).toBeDefined();
    expect((post?.body as { apiKey: string }).apiKey).toBe("sk-test");
  });

  test("cli-managed with stored oauth shows CLI-sign-in copy + Remove + Set API key (no 'not used for runs' jargon)", async () => {
    installStubs();
    const claudeOauth: BackendReadiness = {
      backend: "claude-code",
      installed: true,
      version: "2.0.13",
      reason: "ok",
      checkedAt: 1,
      provider: "anthropic",
      auth: { state: "cli-managed", stored: { kind: "oauth", status: "ok", addedAt: 10 } },
    };
    readinessSeq = [[claudeOauth]];
    const host = await render();
    const oauth = host.querySelector('[data-testid="backend-auth-oauth-claude-code"]');
    expect(oauth).not.toBeNull();
    expect(oauth?.textContent).toContain("Signed in via the CLI");
    expect(host.textContent).not.toContain("not used for runs");
    expect(host.querySelector('[data-testid="backend-auth-remove-claude-code"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="backend-auth-setkey-claude-code"]')).not.toBeNull();
    // No expired warning for a healthy token.
    expect(host.querySelector('[data-testid="backend-auth-expired-claude-code"]')).toBeNull();
  });

  test("cli-managed with EXPIRED stored oauth surfaces a re-sign-in line", async () => {
    installStubs();
    const claudeExpired: BackendReadiness = {
      backend: "claude-code",
      installed: true,
      version: "2.0.13",
      reason: "ok",
      checkedAt: 1,
      provider: "anthropic",
      auth: { state: "cli-managed", stored: { kind: "oauth", status: "expired", addedAt: 10 } },
    };
    readinessSeq = [[claudeExpired]];
    const host = await render();
    const expired = host.querySelector('[data-testid="backend-auth-expired-claude-code"]');
    expect(expired).not.toBeNull();
    expect(expired?.textContent?.toLowerCase()).toContain("expired");
  });

  test("not installed: no Set-API-key form, but a leftover credential keeps a single Remove that DELETEs", async () => {
    installStubs();
    const codexLeftover: BackendReadiness = {
      backend: "codex",
      installed: false,
      version: null,
      reason: "not_installed",
      checkedAt: 1,
      provider: "openai-codex",
      auth: { state: "cli-managed", stored: { kind: "apiKey", status: "ok", addedAt: 10 } },
    };
    readinessSeq = [[codexLeftover]];
    const host = await render();
    // No auth setup affordances.
    expect(host.querySelector('[data-testid="backend-auth-setkey-codex"]')).toBeNull();
    expect(host.querySelector('[data-testid="backend-auth-replace-codex"]')).toBeNull();
    expect(host.querySelector('[data-testid="backend-key-form-codex"]')).toBeNull();
    // Leftover line + a Remove that fires the delete.
    expect(host.querySelector('[data-testid="backend-auth-leftover-codex"]')).not.toBeNull();
    const remove = host.querySelector('[data-testid="backend-auth-remove-codex"]');
    expect(remove).not.toBeNull();
    await act(async () => {
      remove?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const del = calls.find((c) => c.method === "DELETE" && c.path === "/api/secrets/openai-codex");
    expect(del).toBeDefined();
  });

  test("not installed without a leftover shows no auth setup at all", async () => {
    installStubs();
    readinessSeq = [[codexNotInstalled]];
    const host = await render();
    expect(host.querySelector('[data-testid="backend-auth-setkey-codex"]')).toBeNull();
    expect(host.querySelector('[data-testid="backend-auth-leftover-codex"]')).toBeNull();
    expect(host.querySelector('[data-testid="backend-auth-remove-codex"]')).toBeNull();
  });

  test("allowlist controls are ABSENT from this page (moved to Permissions)", async () => {
    installStubs();
    readinessSeq = [[claudeApiKey, codexNotInstalled]];
    const host = await render();
    expect(host.querySelector('[data-testid="allowlist-list"]')).toBeNull();
    expect(host.querySelector('[data-testid="allowlist-deny-all"]')).toBeNull();
    expect(host.querySelector('[data-testid="allowlist-agent-picker"]')).toBeNull();
  });
});
