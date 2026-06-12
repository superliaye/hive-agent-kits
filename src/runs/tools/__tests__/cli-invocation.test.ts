import { describe, expect, test } from "bun:test";
import type { Message } from "../../../model-gateway/types.ts";
import { buildCliInvocation } from "../cli-invocation.ts";

const userTurn = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

describe("buildCliInvocation — claude-code", () => {
  test("no systemPrompt: command is ['claude','-p'], prompt on stdin", () => {
    const inv = buildCliInvocation("claude-code", { history: [userTurn("say hi")] });
    expect(inv.command).toEqual(["claude", "-p"]);
    expect(inv.stdin).toBe("say hi");
  });

  test("with systemPrompt: --append-system-prompt + the body, prompt on stdin", () => {
    const inv = buildCliInvocation("claude-code", {
      systemPrompt: "you are terse",
      history: [userTurn("say hi")],
    });
    expect(inv.command).toEqual(["claude", "-p", "--append-system-prompt", "you are terse"]);
    expect(inv.stdin).toBe("say hi");
  });

  test("uses the LATEST user message, flattening its text blocks", () => {
    const history: Message[] = [
      userTurn("first"),
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      },
    ];
    const inv = buildCliInvocation("claude-code", { history });
    expect(inv.stdin).toBe("hello world");
  });

  test("non-text blocks on the user turn are dropped from the prompt", () => {
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "AAAA" } },
          { type: "text", text: "describe this" },
        ],
      },
    ];
    const inv = buildCliInvocation("claude-code", { history });
    expect(inv.stdin).toBe("describe this");
  });
});

describe("buildCliInvocation — codex", () => {
  test("no systemPrompt: ['codex','exec','-'], prompt on stdin", () => {
    const inv = buildCliInvocation("codex", { history: [userTurn("say hi")] });
    expect(inv.command).toEqual(["codex", "exec", "-"]);
    expect(inv.stdin).toBe("say hi");
  });

  test("with systemPrompt: folded into stdin (no flag)", () => {
    const inv = buildCliInvocation("codex", {
      systemPrompt: "you are terse",
      history: [userTurn("say hi")],
    });
    expect(inv.command).toEqual(["codex", "exec", "-"]);
    expect(inv.stdin).toBe("you are terse\n\nsay hi");
  });
});

describe("buildCliInvocation — redaction", () => {
  test("no raw history beyond the latest user turn leaks into argv", () => {
    const history: Message[] = [
      userTurn("SECRET-EARLIER-TURN"),
      { role: "assistant", content: [{ type: "text", text: "SECRET-ASSISTANT" }] },
      userTurn("current"),
    ];
    const claude = buildCliInvocation("claude-code", { systemPrompt: "sys", history });
    const argv = claude.command.join(" ");
    expect(argv).not.toContain("SECRET-EARLIER-TURN");
    expect(argv).not.toContain("SECRET-ASSISTANT");
    // The latest user text rides stdin, never argv.
    expect(argv).not.toContain("current");
  });
});
