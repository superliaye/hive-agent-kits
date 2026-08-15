// Add-Source UI (#46): the Capabilities header exposes a git-URL input that POSTs
// /api/sources. The daemon onboards (sync + validate) and keeps the Source even
// when non-conformant/empty — so the inline status classifies the 201 by its
// `validation` body (success / empty / conformance-warning) and never drops the
// Source, while a 400 surfaces the issue text inline with the input left editable.
//
// The fetch stub is STATEFUL (mirrors kit-source-toggle.test.tsx): a mutable
// `added` flag flips when POST /api/sources is observed, and only THEN do
// GET /api/sources and GET /api/kit/catalog return the new Source + its
// capability — so the add→appears assertions depend on the post-add
// ["sources"]/["kit"] invalidation refetch, not the initial load.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CapabilityEntry,
  Catalog,
  KitState,
  Source,
  SourceValidationReport,
  VerifyReport,
} from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";
import { overviewFromLegacy } from "./kit-overview-test-helpers.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };
const emptyVerify: VerifyReport = { entries: [] };

const STARTER_ID = "starter-local";
const STARTER_ORIGIN = "https://github.com/superliaye/my-agent-kits";
const ADDED_ID = "added-git";
const ADDED_ORIGIN = "https://github.com/owner/repo";

type Call = { method: string; path: string; body: string | undefined };
let calls: Call[];
// Flips true once POST /api/sources is observed — every subsequent GET reflects
// the new Source + its capability, mirroring the live ["sources"]/["kit"] refetch.
let added: boolean;
// The POST /api/sources outcome the stub returns. "conformant" / "empty" /
// "nonconformant" yield a 201 AddSourceResult; "bad" yields a 400; "duplicate"
// yields a 409.
let addOutcome: "conformant" | "empty" | "nonconformant" | "bad" | "duplicate";

function sources(): Source[] {
  const list: Source[] = [
    {
      id: STARTER_ID,
      label: "Starter",
      locator: { kind: "starter" },
      origin: STARTER_ORIGIN,
      kind: "local",
      active: true,
      createdAt: 1,
      rank: 0,
    },
  ];
  if (added) {
    list.push({
      id: ADDED_ID,
      label: "owner/repo",
      locator: {
        kind: "git",
        repoUrl: ADDED_ORIGIN,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: ADDED_ORIGIN,
      kind: "git",
      active: true,
      createdAt: 2,
      rank: 1,
    });
  }
  return list;
}

// The added Source's lone skill appears in the catalog only after a CONFORMANT,
// non-empty add. An empty add (0 caps) or a non-conformant add (nothing deploys)
// leaves the catalog without it, even though the Source row is kept.
function catalog(): Catalog {
  const hasCap = added && addOutcome === "conformant";
  const entries: CapabilityEntry[] = hasCap
    ? [
        {
          kind: "skill",
          name: "alpha",
          description: "a git capability",
          group: "",
          deployable: true,
          shadowed: false,
          sourceIds: [ADDED_ID],
          contentSha: "a".repeat(64),
        },
      ]
    : [];
  return { entries, presets: [], problems: [] };
}

function kitState(): KitState {
  const sync: KitState["sync"] = [
    {
      state: "local",
      sha: null,
      fetchedAt: 1,
      sourceId: STARTER_ID,
      origin: STARTER_ORIGIN,
    },
  ];
  if (added) {
    sync.push({
      state: "up_to_date",
      sha: "abc1234def",
      fetchedAt: 1,
      sourceId: ADDED_ID,
      origin: ADDED_ORIGIN,
    });
  }
  return { sync, ledger: null };
}

function validation(): SourceValidationReport {
  if (addOutcome === "nonconformant") {
    return {
      conformant: false,
      errors: [
        { kind: "skill", name: "alpha", message: "missing frontmatter" },
        { kind: "agent", name: "beta", message: "invalid tools list" },
      ],
      capabilityCount: 2,
    };
  }
  if (addOutcome === "empty") {
    return { conformant: true, errors: [], capabilityCount: 0 };
  }
  return { conformant: true, errors: [], capabilityCount: 1 };
}

function addResult(): unknown {
  return {
    source: {
      id: ADDED_ID,
      label: "owner/repo",
      locator: {
        kind: "git",
        repoUrl: ADDED_ORIGIN,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: ADDED_ORIGIN,
      kind: "git",
      active: true,
      createdAt: 2,
      rank: 1,
    },
    sync: {
      state: "up_to_date",
      sha: "abc1234def",
      fetchedAt: 1,
      sourceId: ADDED_ID,
      origin: ADDED_ORIGIN,
    },
    validation: validation(),
  };
}

function installStubs(): void {
  calls = [];
  added = false;
  addOutcome = "conformant";
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path, body });

    if (path === "/api/sources" && method === "POST") {
      if (addOutcome === "bad") {
        return json(
          {
            error: "invalid source",
            issues: [{ path: "origin", message: "origin must be an https URL" }],
          },
          400,
        );
      }
      if (addOutcome === "duplicate") {
        return json({ error: "duplicate origin", origin: ADDED_ORIGIN }, 409);
      }
      // The daemon keeps the Source on a 201 regardless of conformance — flip the
      // flag so the post-add refetch surfaces the new row + (conformant) caps.
      added = true;
      return json(addResult(), 201);
    }
    if (path === "/api/kit/overview")
      return json(
        overviewFromLegacy({ catalog: catalog(), state: kitState(), sources: sources() }),
      );
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/kit/diff" && method === "POST") return json({ entries: [] });
    if (path === "/api/sources" && method === "GET") return json(sources());
    return json({});
  }) as typeof fetch;
}

let activeRoot: Root | null = null;

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

async function render(): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(KitDeployPage, { apiConfig }),
      ),
    );
  });
  await flush();
  return host;
}

async function typeUrl(input: HTMLInputElement, url: string): Promise<void> {
  await act(async () => {
    input.value = url;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

describe("KitDeployPage — Add-Source UI (#46)", () => {
  test("(a) the Add-Source form renders an input + submit in the header", async () => {
    installStubs();
    const host = await render();
    expect(host.querySelector('[data-testid="add-source-form"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="add-source-input"]')).not.toBeNull();
    const submit = host.querySelector('[data-testid="add-source-submit"]');
    expect(submit).not.toBeNull();
    // The form lives inside the Capabilities header version block.
    expect(
      host.querySelector('.kit-header-version [data-testid="add-source-form"]'),
    ).not.toBeNull();
  });

  test("(b) add → appears: POSTs { origin }, success banner, new Source row + capability row appear after refetch", async () => {
    installStubs();
    const host = await render();

    // The added Source's capability is ABSENT before submit.
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-${ADDED_ID}"]`)).toBeNull();

    const input = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    await typeUrl(input, ADDED_ORIGIN);
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);

    // The request uses the locator-native Source contract.
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/sources");
    expect(post).not.toBeUndefined();
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      label: "owner/repo",
      locator: {
        kind: "git",
        repoUrl: ADDED_ORIGIN,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
    });

    // Success banner shows the owner/repo label + the capability count.
    const success = host.querySelector('[data-testid="add-source-success"]');
    expect(success).not.toBeNull();
    expect(success?.textContent).toContain("owner/repo");
    expect(success?.textContent).toContain("1 capability");

    // (i) the new Source row appears in kit-sources labelled owner/repo…
    const row = host.querySelector(`[data-testid="kit-source-${ADDED_ID}"]`);
    expect(row).not.toBeNull();
    expect(row?.querySelector(".kit-source-origin")?.textContent).toBe("owner/repo");
    // …and (ii) the new Source's capability row now renders in the catalog.
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();

    // The field was cleared on success.
    expect((host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement).value).toBe(
      "",
    );
  });

  test("(c) a 400 surfaces the issue message inline and leaves the input enabled for retry", async () => {
    installStubs();
    const host = await render();
    addOutcome = "bad";

    const input = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    await typeUrl(input, "not-a-url");
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);

    const err = host.querySelector('[data-testid="add-source-error"]');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain("origin must be an https URL");

    // The input stays enabled for retry, and no Source row was added.
    expect(
      (host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(host.querySelector(`[data-testid="kit-source-${ADDED_ID}"]`)).toBeNull();
  });

  test("(d) a non-conformant 201 shows a warning with the problem count and keeps the Source row", async () => {
    installStubs();
    const host = await render();
    addOutcome = "nonconformant";

    const input = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    await typeUrl(input, ADDED_ORIGIN);
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);

    const warn = host.querySelector('[data-testid="add-source-warning"]');
    expect(warn).not.toBeNull();
    // Two conformance errors → "2 conformance problems".
    expect(warn?.textContent).toContain("2 conformance problem");
    // The Source is NOT removed — its row is present after the refetch.
    expect(host.querySelector(`[data-testid="kit-source-${ADDED_ID}"]`)).not.toBeNull();
  });

  test("(e) a 409 duplicate surfaces the duplicate-origin error inline and adds no row", async () => {
    installStubs();
    const host = await render();
    addOutcome = "duplicate";

    const input = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    await typeUrl(input, ADDED_ORIGIN);
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);

    const err = host.querySelector('[data-testid="add-source-error"]');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain("Already added:");
    expect(err?.textContent).toContain(ADDED_ORIGIN);
    // No row added (the duplicate already exists; the stub never flips `added`).
    expect(host.querySelector(`[data-testid="kit-source-${ADDED_ID}"]`)).toBeNull();
    // Input stays enabled for retry.
    expect(
      (host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement).disabled,
    ).toBe(false);
  });

  test("(f) a conformant-but-empty 201 shows the empty banner and still adds the Source row", async () => {
    installStubs();
    const host = await render();
    addOutcome = "empty";

    const input = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    await typeUrl(input, ADDED_ORIGIN);
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);

    const empty = host.querySelector('[data-testid="add-source-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("no capabilities found");
    // The Source is kept even with zero capabilities — its row appears.
    expect(host.querySelector(`[data-testid="kit-source-${ADDED_ID}"]`)).not.toBeNull();
    // No capability row (the catalog stays empty for this Source).
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).toBeNull();
  });

  test("(g) a later error clears a prior success banner — the two states never co-render", async () => {
    installStubs();
    const host = await render();

    // First submit succeeds.
    const input = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    await typeUrl(input, ADDED_ORIGIN);
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);
    expect(host.querySelector('[data-testid="add-source-success"]')).not.toBeNull();

    // Second submit fails (400). The stale success banner must be gone and only the
    // error banner present.
    addOutcome = "bad";
    await typeUrl(input, "another-url");
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);

    expect(host.querySelector('[data-testid="add-source-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="add-source-success"]')).toBeNull();
  });

  test("(h) settled Add Source status clears as soon as the user edits or clears the input", async () => {
    installStubs();
    const host = await render();
    addOutcome = "bad";

    const input = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    await typeUrl(input, "not-a-url");
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);
    expect(host.querySelector('[data-testid="add-source-error"]')).not.toBeNull();

    await typeUrl(input, "https://github.com/owner/retry");
    expect(host.querySelector('[data-testid="add-source-error"]')).toBeNull();

    addOutcome = "empty";
    await submitForm(host.querySelector('[data-testid="add-source-form"]') as HTMLFormElement);
    expect(host.querySelector('[data-testid="add-source-empty"]')).not.toBeNull();

    await typeUrl(input, "");
    expect(host.querySelector('[data-testid="add-source-empty"]')).toBeNull();
  });
});
