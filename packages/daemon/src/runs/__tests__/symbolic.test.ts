import { describe, expect, test } from "bun:test";
import type { AvailableModel } from "../model-catalog.ts";
import { orderByRecency } from "../model-catalog.ts";
import {
  isSymbolicEffort,
  isSymbolicModel,
  isThinkingEffort,
  PROVIDER_PREFERENCE,
  resolveHighestEffort,
  resolveLatestModel,
  runnableCatalog,
} from "../symbolic.ts";

function model(id: string, efforts: AvailableModel["efforts"] = ["off"]): AvailableModel {
  const [provider, modelId] = id.split("/") as [string, string];
  return { provider, modelId, model: id, efforts };
}

describe("symbolic — token predicates", () => {
  test('"latest" is a symbolic model; concrete ids are not', () => {
    expect(isSymbolicModel("latest")).toBe(true);
    expect(isSymbolicModel("openai-codex/gpt-5.4-mini")).toBe(false);
    expect(isSymbolicModel(undefined)).toBe(false);
  });

  test('"highest" is a symbolic effort; concrete levels are not', () => {
    expect(isSymbolicEffort("highest")).toBe(true);
    expect(isSymbolicEffort("xhigh")).toBe(false);
    expect(isSymbolicEffort(undefined)).toBe(false);
  });

  test("isThinkingEffort accepts EFFORT_ORDER members only (shared helper, P3)", () => {
    expect(isThinkingEffort("xhigh")).toBe(true);
    expect(isThinkingEffort("off")).toBe(true);
    expect(isThinkingEffort("highest")).toBe(false); // symbolic, not concrete
    expect(isThinkingEffort("bogus")).toBe(false);
    expect(isThinkingEffort(undefined)).toBe(false);
  });
});

describe("orderByRecency — deterministic, provider-scoped recency ordering", () => {
  test("newest-first by id, numeric-aware (5.10 > 5.9)", () => {
    const ordered = orderByRecency([
      model("openai-codex/gpt-5.9"),
      model("openai-codex/gpt-5.10"),
      model("openai-codex/gpt-5.4-mini"),
    ]);
    expect(ordered.map((m) => m.modelId)).toEqual(["gpt-5.10", "gpt-5.9", "gpt-5.4-mini"]);
  });

  test("is a pure function (input not mutated) and stable on ties", () => {
    const input = [model("p/a"), model("p/a")];
    const ordered = orderByRecency(input);
    expect(ordered).not.toBe(input);
    expect(ordered).toHaveLength(2);
  });
});

describe('resolveLatestModel — "latest" picks the top of the runnable catalog', () => {
  test("picks the newest-first head", () => {
    const catalog = {
      models: orderByRecency([model("openai-codex/gpt-5.4-mini"), model("openai-codex/gpt-5.10")]),
    };
    expect(resolveLatestModel(catalog)?.model).toBe("openai-codex/gpt-5.10");
  });

  test("undefined when the runnable catalog is empty", () => {
    expect(resolveLatestModel({ models: [] })).toBeUndefined();
  });
});

describe("runnableCatalog — single shared credentialed ∩ routable + ordered helper", () => {
  function lister(byProvider: Record<string, AvailableModel[]>) {
    return (p: string) => byProvider[p] ?? [];
  }

  test("intersects credentialed with routable (a credentialed-but-unroutable provider drops out)", () => {
    const secrets = { list: () => [{ provider: "anthropic" }, { provider: "not-routable" }] };
    const gw = lister({ anthropic: [model("anthropic/claude-opus-4-7")] });
    const cat = runnableCatalog(secrets, gw);
    expect(cat.models.map((m) => m.model)).toEqual(["anthropic/claude-opus-4-7"]);
  });

  test("orders WITHIN a provider by recency and ACROSS providers by PROVIDER_PREFERENCE (not lexical)", () => {
    // openai-codex listed FIRST in secrets, but anthropic outranks it by
    // PROVIDER_PREFERENCE, so anthropic's models come first regardless of id.
    const secrets = { list: () => [{ provider: "openai-codex" }, { provider: "anthropic" }] };
    const gw = lister({
      "openai-codex": [model("openai-codex/gpt-5.9"), model("openai-codex/gpt-5.10")],
      anthropic: [model("anthropic/claude-opus-4-7")],
    });
    const cat = runnableCatalog(secrets, gw);
    expect(cat.models.map((m) => m.model)).toEqual([
      "anthropic/claude-opus-4-7",
      "openai-codex/gpt-5.10",
      "openai-codex/gpt-5.9",
    ]);
  });

  test("with only openai-codex credentialed, latest is its newest (finding #3 case)", () => {
    const secrets = { list: () => [{ provider: "openai-codex" }] };
    const gw = lister({
      "openai-codex": [model("openai-codex/gpt-5.4-mini"), model("openai-codex/gpt-5.10")],
    });
    const cat = runnableCatalog(secrets, gw);
    expect(resolveLatestModel(cat)?.model).toBe("openai-codex/gpt-5.10");
  });

  test("empty when nothing is credentialed", () => {
    expect(runnableCatalog({ list: () => [] }, lister({})).models).toEqual([]);
  });

  test("PROVIDER_PREFERENCE prefers anthropic over openai-codex", () => {
    expect(PROVIDER_PREFERENCE.indexOf("anthropic")).toBeLessThan(
      PROVIDER_PREFERENCE.indexOf("openai-codex"),
    );
  });

  test("unlisted providers tie-break by localeCompare, not by secrets.list() incoming order (P5)", () => {
    // Both providers are absent from PROVIDER_PREFERENCE (equal rank). Their
    // cross-provider order must be self-contained (localeCompare), independent
    // of the order secrets.list() hands them in.
    const gw = lister({
      zebra: [model("zebra/m1")],
      alpha: [model("alpha/m1")],
    });
    const incomingZebraFirst = runnableCatalog(
      { list: () => [{ provider: "zebra" }, { provider: "alpha" }] },
      gw,
    );
    const incomingAlphaFirst = runnableCatalog(
      { list: () => [{ provider: "alpha" }, { provider: "zebra" }] },
      gw,
    );
    const expected = ["alpha/m1", "zebra/m1"];
    expect(incomingZebraFirst.models.map((m) => m.model)).toEqual(expected);
    expect(incomingAlphaFirst.models.map((m) => m.model)).toEqual(expected);
  });
});

describe('resolveHighestEffort — "highest" picks the strongest supported level', () => {
  test("strongest level per EFFORT_ORDER from the model's subset", () => {
    expect(resolveHighestEffort(["off", "minimal", "xhigh"])).toBe("xhigh");
    expect(resolveHighestEffort(["off", "low", "medium"])).toBe("medium");
  });

  test("undefined when no levels (preserves no-effort-fallback)", () => {
    expect(resolveHighestEffort([])).toBeUndefined();
  });
});
