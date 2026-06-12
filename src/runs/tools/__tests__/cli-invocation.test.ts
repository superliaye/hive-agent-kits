import { describe, expect, test } from "bun:test";
import type { Message } from "../../../model-gateway/types.ts";
import { buildCliInvocation } from "../cli-invocation.ts";

const userTurn = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

describe("buildCliInvocation — claude-code", () => {
  test("CREATE (default): JSON-stream argv, prompt on stdin", () => {
    const inv = buildCliInvocation("claude-code", { history: [userTurn("say hi")] });
    expect(inv.command).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
    expect(inv.stdin).toBe("say hi");
  });

  test("CREATE with systemPrompt: --append-system-prompt after the stream flags", () => {
    const inv = buildCliInvocation("claude-code", {
      systemPrompt: "you are terse",
      history: [userTurn("say hi")],
    });
    expect(inv.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      "you are terse",
    ]);
    expect(inv.stdin).toBe("say hi");
  });

  test("RESUME: adds --resume <sessionId>", () => {
    const inv = buildCliInvocation("claude-code", {
      history: [userTurn("next")],
      mode: { kind: "resume", sessionId: "sess-abc" },
    });
    expect(inv.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "sess-abc",
    ]);
    expect(inv.stdin).toBe("next");
  });

  test("addDir: --add-dir after the stream flags, before --append-system-prompt", () => {
    const inv = buildCliInvocation("claude-code", {
      systemPrompt: "you are terse",
      history: [userTurn("say hi")],
      addDir: "/hive/proj/run-1",
    });
    expect(inv.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--add-dir",
      "/hive/proj/run-1",
      "--append-system-prompt",
      "you are terse",
    ]);
  });

  test("addDir + RESUME: --add-dir precedes --resume", () => {
    const inv = buildCliInvocation("claude-code", {
      history: [userTurn("next")],
      mode: { kind: "resume", sessionId: "sess-abc" },
      addDir: "/hive/proj/run-2",
    });
    expect(inv.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--add-dir",
      "/hive/proj/run-2",
      "--resume",
      "sess-abc",
    ]);
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
  test("CREATE (default): ['codex','exec','--json','-'], prompt on stdin", () => {
    const inv = buildCliInvocation("codex", { history: [userTurn("say hi")] });
    expect(inv.command).toEqual(["codex", "exec", "--json", "-"]);
    expect(inv.stdin).toBe("say hi");
  });

  test("CREATE with systemPrompt: folded into stdin (no flag)", () => {
    const inv = buildCliInvocation("codex", {
      systemPrompt: "you are terse",
      history: [userTurn("say hi")],
    });
    expect(inv.command).toEqual(["codex", "exec", "--json", "-"]);
    expect(inv.stdin).toBe("you are terse\n\nsay hi");
  });

  test("addDir is ignored (v1): codex argv carries no --add-dir", () => {
    const inv = buildCliInvocation("codex", {
      history: [userTurn("say hi")],
      addDir: "/hive/proj/run-1",
    });
    expect(inv.command).toEqual(["codex", "exec", "--json", "-"]);
    expect(inv.command).not.toContain("--add-dir");
  });

  test("RESUME: ['codex','exec','resume',<id>,'--json','-']", () => {
    const inv = buildCliInvocation("codex", {
      history: [userTurn("next")],
      mode: { kind: "resume", sessionId: "thr-xyz" },
    });
    expect(inv.command).toEqual(["codex", "exec", "resume", "thr-xyz", "--json", "-"]);
    expect(inv.stdin).toBe("next");
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
