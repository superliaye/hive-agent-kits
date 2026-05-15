import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { claudeCliAdapter } from "../adapters/claude-cli.ts";
import { complete } from "../index.ts";
import { _resetRegistry, registerAdapter } from "../registry.ts";
import type { GatewayEvent } from "../types.ts";

async function claudeOnPath(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

describe("claude-cli adapter (smoke)", () => {
  let available = false;

  beforeAll(async () => {
    available = await claudeOnPath();
    if (!available) {
      console.warn("[claude-cli.smoke] `claude` CLI not on PATH — smoke tests will be skipped.");
    }
  });

  afterEach(() => {
    _resetRegistry();
  });

  test("real complete() emits text + done(stop) with HELLO", async () => {
    if (!available) {
      console.warn("skipped — claude CLI not on PATH");
      return;
    }
    registerAdapter(claudeCliAdapter);

    const events: GatewayEvent[] = [];
    let collectedText = "";
    for await (const ev of complete({
      model: "claude-cli/sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Say only the word HELLO." }],
        },
      ],
      auth: { kind: "apiKey", apiKey: "" },
    })) {
      events.push(ev);
      if (ev.type === "text_delta") collectedText += ev.delta;
    }

    console.log("[claude-cli.smoke] collected text:", JSON.stringify(collectedText));

    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");

    const last = events[events.length - 1];
    expect(last?.type).toBe("done");
    if (last?.type === "done") {
      expect(last.finishReason).toBe("stop");
    }

    expect(collectedText.toUpperCase()).toContain("HELLO");
  }, 120_000);
});
