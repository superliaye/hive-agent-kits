import { describe, expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Phase-0 fail-fast gate (vendor-sdk-cli-backends design, Build sequencing 0 / Risk 1):
// does @anthropic-ai/claude-agent-sdk spawn its bundled Claude Code binary under Bun
// and complete a trivial turn? The bundled CLI is a Bun-compiled binary with known
// `ReferenceError: Bun is not defined` / binary-resolution failure modes — this proves
// the spawn path the Claude adapter will use, before any adapter is built.
//
// Real LLM round-trip → OPT-IN: default `bun test` stays offline + deterministic.
// Set HIVE_SMOKE=1 to run. Requires Claude auth in env (ANTHROPIC_API_KEY or
// CLAUDE_CODE_OAUTH_TOKEN). Escape hatch on spawn failure: pathToClaudeCodeExecutable.
const RUN_SMOKE = process.env.HIVE_SMOKE === "1";

function claudeAuthPresent(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
}

describe.skipIf(!RUN_SMOKE)("claude-agent-sdk spawn under Bun (smoke)", () => {
  test("query() spawns + completes a trivial turn with non-empty assistant text", async () => {
    if (!claudeAuthPresent()) {
      console.warn("[claude-sdk.smoke] no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — skipped.");
      return;
    }

    let assistantText = "";
    let sessionId: string | undefined;
    let resultOk = false;

    for await (const message of query({
      prompt: "Say only the word HELLO.",
      options: {
        executable: "bun",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      }
      if (message.type === "result") {
        resultOk = message.subtype === "success";
      }
    }

    console.log("[claude-sdk.smoke] session:", sessionId, "text:", JSON.stringify(assistantText));

    expect(sessionId).toBeTruthy();
    expect(resultOk).toBe(true);
    expect(assistantText.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
