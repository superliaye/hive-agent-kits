import { describe, expect, test } from "bun:test";
import type { AvailableModel } from "../../model-gateway/types.ts";
import { MODEL_FALLBACK } from "../defaults.ts";
import { resolve } from "../resolve.ts";
import type { RunnableCatalog } from "../symbolic.ts";

function avail(id: string, efforts: AvailableModel["efforts"] = ["off"]): AvailableModel {
  const [provider, modelId] = id.split("/") as [string, string];
  return { provider, modelId, model: id, efforts };
}

// A newest-first runnable catalog with a single credentialed provider.
function catalog(): RunnableCatalog {
  return {
    models: [
      avail("openai-codex/gpt-5.10", ["off", "minimal", "xhigh"]),
      avail("openai-codex/gpt-5.4-mini", ["off", "minimal"]),
    ],
  };
}

// Base input — no tiers set. Each test overrides exactly the tier under test so
// the precedence ordering (override > user default > harness config > fallback)
// is pinned independently per tier.
function base() {
  return {
    // A Worker agent by default (any id other than root/agent-manager), so the
    // backend-tier tests below exercise the passthrough, not the worker-only gate.
    agentId: "worker-1",
    configuredModel: undefined,
    configuredEffort: undefined,
    userModelDefault: undefined,
    userEffortDefault: undefined,
    backend: "native" as const,
  };
}

describe("resolve — model tier (delegates to resolveAgentModel, ADR-0013)", () => {
  test("falls back to MODEL_FALLBACK when nothing is set", () => {
    const r = resolve(base());
    expect("failure" in r).toBe(false);
    if (!("failure" in r)) expect(r.model).toBe(MODEL_FALLBACK);
  });

  test("harness config.model used when nothing earlier resolves", () => {
    const r = resolve({ ...base(), configuredModel: "anthropic/claude-haiku-4-5" });
    if (!("failure" in r)) expect(r.model).toBe("anthropic/claude-haiku-4-5");
  });

  test("user default beats harness config.model", () => {
    const r = resolve({
      ...base(),
      configuredModel: "anthropic/claude-haiku-4-5",
      userModelDefault: "anthropic/claude-sonnet-4-6",
    });
    if (!("failure" in r)) expect(r.model).toBe("anthropic/claude-sonnet-4-6");
  });

  test("per-Run override beats the user default", () => {
    const r = resolve({
      ...base(),
      configuredModel: "anthropic/claude-haiku-4-5",
      userModelDefault: "anthropic/claude-sonnet-4-6",
      modelOverride: "anthropic/claude-opus-4-7",
    });
    if (!("failure" in r)) expect(r.model).toBe("anthropic/claude-opus-4-7");
  });

  test("malformed model surfaces a failure", () => {
    const r = resolve({ ...base(), configuredModel: "no-provider-here" });
    expect("failure" in r).toBe(true);
  });
});

describe("resolve — effort tier (preserves no-effort fallback)", () => {
  test("no effort anywhere → undefined (loop omits thinking)", () => {
    const r = resolve(base());
    if (!("failure" in r)) expect(r.effort).toBeUndefined();
  });

  test("harness config.thinkingEffort used when nothing earlier resolves", () => {
    const r = resolve({ ...base(), configuredEffort: "medium" });
    if (!("failure" in r)) expect(r.effort).toBe("medium");
  });

  test("unrecognized harness effort is ignored (stays undefined)", () => {
    const r = resolve({ ...base(), configuredEffort: "bogus" });
    if (!("failure" in r)) expect(r.effort).toBeUndefined();
  });

  test("user effort default beats harness config", () => {
    const r = resolve({ ...base(), configuredEffort: "low", userEffortDefault: "high" });
    if (!("failure" in r)) expect(r.effort).toBe("high");
  });

  test("per-Run effort override beats the user default", () => {
    const r = resolve({
      ...base(),
      configuredEffort: "low",
      userEffortDefault: "high",
      effortOverride: "xhigh",
    });
    if (!("failure" in r)) expect(r.effort).toBe("xhigh");
  });
});

describe("resolve — symbolic defaults (S2, ADR-0015)", () => {
  test('"latest" model resolves to the runnable-catalog head', () => {
    const r = resolve({ ...base(), configuredModel: "latest", runnableCatalog: catalog() });
    expect("failure" in r).toBe(false);
    if (!("failure" in r)) {
      expect(r.model).toBe("openai-codex/gpt-5.10");
      expect(r.provider).toBe("openai-codex");
    }
  });

  test('"latest" with an empty runnable catalog → typed model_not_found failure', () => {
    const r = resolve({ ...base(), configuredModel: "latest", runnableCatalog: { models: [] } });
    expect("failure" in r).toBe(true);
    if ("failure" in r) expect(r.failure.code).toBe("model_not_found");
  });

  test('"latest" with no catalog supplied → typed failure (nothing to resolve to)', () => {
    const r = resolve({ ...base(), configuredModel: "latest" });
    expect("failure" in r).toBe(true);
  });

  test('"highest" effort resolves against the resolved model\'s efforts', () => {
    const r = resolve({
      ...base(),
      configuredModel: "latest",
      configuredEffort: "highest",
      runnableCatalog: catalog(),
    });
    if (!("failure" in r)) expect(r.effort).toBe("xhigh");
  });

  test('"highest" effort on a concrete model looks efforts up in the catalog', () => {
    const r = resolve({
      ...base(),
      configuredModel: "openai-codex/gpt-5.4-mini",
      userEffortDefault: "highest",
      runnableCatalog: catalog(),
    });
    if (!("failure" in r)) expect(r.effort).toBe("minimal");
  });

  test('"highest" with no catalog efforts → undefined (no thinking block)', () => {
    const r = resolve({ ...base(), configuredModel: "p/m", configuredEffort: "highest" });
    if (!("failure" in r)) expect(r.effort).toBeUndefined();
  });

  test("Thread-scope symbolic model beats a concrete user default", () => {
    const r = resolve({
      ...base(),
      userModelDefault: "openai-codex/gpt-5.4-mini",
      threadModel: "latest",
      runnableCatalog: catalog(),
    });
    if (!("failure" in r)) expect(r.model).toBe("openai-codex/gpt-5.10");
  });
});

describe("resolve — Thread scope tier (S1, ADR-0015)", () => {
  test("Thread model beats user default, loses to per-Run override", () => {
    const r = resolve({
      ...base(),
      userModelDefault: "anthropic/claude-haiku-4-5",
      threadModel: "anthropic/claude-sonnet-4-6",
    });
    if (!("failure" in r)) expect(r.model).toBe("anthropic/claude-sonnet-4-6");

    const r2 = resolve({
      ...base(),
      userModelDefault: "anthropic/claude-haiku-4-5",
      threadModel: "anthropic/claude-sonnet-4-6",
      modelOverride: "anthropic/claude-opus-4-7",
    });
    if (!("failure" in r2)) expect(r2.model).toBe("anthropic/claude-opus-4-7");
  });

  test("Thread effort beats user default, loses to per-Run override", () => {
    const r = resolve({ ...base(), userEffortDefault: "low", threadEffort: "high" });
    if (!("failure" in r)) expect(r.effort).toBe("high");

    const r2 = resolve({
      ...base(),
      userEffortDefault: "low",
      threadEffort: "high",
      effortOverride: "xhigh",
    });
    if (!("failure" in r2)) expect(r2.effort).toBe("xhigh");
  });

  test("axes stay independent — a Thread model pick leaves effort untouched", () => {
    const r = resolve({
      ...base(),
      threadModel: "anthropic/claude-sonnet-4-6",
      configuredEffort: "medium",
    });
    if (!("failure" in r)) {
      expect(r.model).toBe("anthropic/claude-sonnet-4-6");
      expect(r.effort).toBe("medium");
    }
  });
});

describe("resolve — backend passthrough", () => {
  test("native passes through", () => {
    const r = resolve({ ...base(), backend: "native" });
    if (!("failure" in r)) expect(r.backend).toBe("native");
  });

  test("claude-code passes through unchanged", () => {
    const r = resolve({ ...base(), backend: "claude-code" });
    if (!("failure" in r)) expect(r.backend).toBe("claude-code");
  });

  test("codex passes through unchanged", () => {
    const r = resolve({ ...base(), backend: "codex" });
    if (!("failure" in r)) expect(r.backend).toBe("codex");
  });
});

describe("resolve — backend tier (Thread pick > user default > harness, OQ-1)", () => {
  test("Thread backend beats the harness backend", () => {
    const r = resolve({ ...base(), backend: "native", threadBackend: "claude-code" });
    if (!("failure" in r)) expect(r.backend).toBe("claude-code");
  });

  test("Thread backend beats the user agent default", () => {
    const r = resolve({
      ...base(),
      backend: "native",
      userBackendDefault: "codex",
      threadBackend: "claude-code",
    });
    if (!("failure" in r)) expect(r.backend).toBe("claude-code");
  });

  test("user agent default beats the harness backend when no Thread pick", () => {
    const r = resolve({ ...base(), backend: "native", userBackendDefault: "codex" });
    if (!("failure" in r)) expect(r.backend).toBe("codex");
  });

  test("harness backend is the terminal fallback", () => {
    const r = resolve({ ...base(), backend: "claude-code" });
    if (!("failure" in r)) expect(r.backend).toBe("claude-code");
  });
});

describe("resolve — agent-manager native-lock (authoritative guard, ADR-0018)", () => {
  test("a non-native Thread pick on the Agent Manager is neutralized to native", () => {
    const r = resolve({
      ...base(),
      agentId: "agent-manager",
      backend: "native",
      threadBackend: "codex",
    });
    if (!("failure" in r)) expect(r.backend).toBe("native");
  });

  test("a non-native user default on the Agent Manager is neutralized to native", () => {
    const r = resolve({
      ...base(),
      agentId: "agent-manager",
      backend: "native",
      userBackendDefault: "claude-code",
    });
    if (!("failure" in r)) expect(r.backend).toBe("native");
  });

  test("a non-native harness backend on the Agent Manager is neutralized to native", () => {
    const r = resolve({ ...base(), agentId: "agent-manager", backend: "claude-code" });
    if (!("failure" in r)) expect(r.backend).toBe("native");
  });

  test("Root MAY keep its non-native pick (ADR-0018 relaxes the gate to Root)", () => {
    const r = resolve({ ...base(), agentId: "root", backend: "native", threadBackend: "codex" });
    if (!("failure" in r)) expect(r.backend).toBe("codex");
  });

  test("a Worker agent keeps its non-native pick", () => {
    const r = resolve({
      ...base(),
      agentId: "worker-9",
      backend: "native",
      threadBackend: "codex",
    });
    if (!("failure" in r)) expect(r.backend).toBe("codex");
  });

  test("a Worker / Root agent with a non-native backend resolves to that backend (no neutralization)", () => {
    const worker = resolve({ ...base(), agentId: "worker-9", backend: "codex" });
    if (!("failure" in worker)) expect(worker.backend).toBe("codex");
    const root = resolve({ ...base(), agentId: "root", backend: "claude-code" });
    if (!("failure" in root)) expect(root.backend).toBe("claude-code");
  });
});
