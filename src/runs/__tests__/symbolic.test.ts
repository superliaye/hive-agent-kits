import { describe, expect, test } from "bun:test";
import { orderByRecency } from "../../model-gateway/index.ts";
import type { AvailableModel } from "../../model-gateway/types.ts";
import {
  isSymbolicEffort,
  isSymbolicModel,
  resolveHighestEffort,
  resolveLatestModel,
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

describe('resolveHighestEffort — "highest" picks the strongest supported level', () => {
  test("strongest level per EFFORT_ORDER from the model's subset", () => {
    expect(resolveHighestEffort(["off", "minimal", "xhigh"])).toBe("xhigh");
    expect(resolveHighestEffort(["off", "low", "medium"])).toBe("medium");
  });

  test("undefined when no levels (preserves no-effort-fallback)", () => {
    expect(resolveHighestEffort([])).toBeUndefined();
  });
});
