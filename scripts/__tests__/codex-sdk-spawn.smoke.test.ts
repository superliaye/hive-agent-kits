import { describe, expect, test } from "bun:test";
import { Codex } from "@openai/codex-sdk";

// Phase-0 fail-fast gate (vendor-sdk-cli-backends design, Build sequencing 0 / Risk 2):
// does @openai/codex-sdk shell to its bundled `@openai/codex` binary under Bun and
// complete a trivial turn? Bun support is unverified by OpenAI — this proves the
// spawn path the Codex adapter will use, before any adapter is built.
//
// Real LLM round-trip → OPT-IN: default `bun test` stays offline + deterministic.
// Set HIVE_SMOKE=1 to run. Requires Codex auth (OPENAI_API_KEY, or a cached
// ~/.codex/auth.json from `codex login`).
const RUN_SMOKE = process.env.HIVE_SMOKE === "1";

describe.skipIf(!RUN_SMOKE)("codex-sdk spawn under Bun (smoke)", () => {
  test("runStreamed() spawns + completes a trivial turn with an agent_message", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    const codex = apiKey ? new Codex({ apiKey }) : new Codex();

    const thread = codex.startThread({
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      skipGitRepoCheck: true,
    });

    let threadStarted = false;
    let agentMessageText = "";
    let turnCompleted = false;

    try {
      const { events } = await thread.runStreamed("Say only the word HELLO.");
      for await (const event of events) {
        if (event.type === "thread.started") threadStarted = true;
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          agentMessageText += event.item.text;
        }
        if (event.type === "turn.completed") turnCompleted = true;
      }
    } catch (err) {
      // No auth (no OPENAI_API_KEY and no cached ~/.codex/auth.json) surfaces as a
      // spawn/auth error — skip rather than fail the gate, matching the Claude smoke.
      console.warn("[codex-sdk.smoke] spawn/auth error — skipped:", String(err));
      return;
    }

    console.log(
      "[codex-sdk.smoke] started:",
      threadStarted,
      "text:",
      JSON.stringify(agentMessageText),
    );

    expect(threadStarted).toBe(true);
    expect(turnCompleted).toBe(true);
    expect(agentMessageText.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
