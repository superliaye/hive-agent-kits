import { describe, expect, test } from "bun:test";
import { type AvailableModel, forwardableModels } from "../../api.ts";

function model(provider: string, id: string): AvailableModel {
  return { provider, modelId: id, model: `${provider}/${id}`, efforts: ["off"] };
}

const models: AvailableModel[] = [
  model("anthropic", "claude-sonnet-4-6"),
  model("openai-codex", "gpt-5.5"),
  model("anthropic", "claude-opus-4-8"),
];

describe("forwardableModels", () => {
  test("native and no-backend route every configured model", () => {
    expect(forwardableModels(models, "native")).toEqual(models);
    expect(forwardableModels(models, null)).toEqual(models);
  });

  test("claude-code keeps only anthropic-provider models (others run the CLI's own)", () => {
    expect(forwardableModels(models, "claude-code").map((m) => m.model)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-8",
    ]);
  });

  test("codex forwards no Hive-picked model today", () => {
    expect(forwardableModels(models, "codex")).toEqual([]);
  });
});
