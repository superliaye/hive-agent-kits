import { describe, expect, test } from "bun:test";
import type { Message } from "../../../model-gateway/types.ts";
import { buildCliInvocation, claudeModelEffort, claudePermission } from "../cli-invocation.ts";

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

// ─── P1.1: the pure model/effort transform (Q1) ──────────────────────────────
describe("claudeModelEffort — model transform (provider-matched, bare id)", () => {
  test("anthropic provider → bare id, provider/ prefix stripped", () => {
    expect(
      claudeModelEffort({ provider: "anthropic", model: "anthropic/claude-sonnet-4-6" }),
    ).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("non-anthropic provider → NO --model (cross-provider id is meaningless to claude)", () => {
    expect(claudeModelEffort({ provider: "openai", model: "openai/gpt-5" })).toEqual({});
  });

  test("absent model → NO --model even for anthropic", () => {
    expect(claudeModelEffort({ provider: "anthropic" })).toEqual({});
  });
});

describe("claudeModelEffort — effort transform (intersection map, per-level guard)", () => {
  test("intersection levels map 1:1: low/medium/high/xhigh", () => {
    expect(claudeModelEffort({ effort: "low" })).toEqual({ effort: "low" });
    expect(claudeModelEffort({ effort: "medium" })).toEqual({ effort: "medium" });
    expect(claudeModelEffort({ effort: "high" })).toEqual({ effort: "high" });
    expect(claudeModelEffort({ effort: "xhigh" })).toEqual({ effort: "xhigh" });
  });

  test("off/minimal have no claude equivalent → NO --effort (CLI default)", () => {
    expect(claudeModelEffort({ effort: "off" })).toEqual({});
    expect(claudeModelEffort({ effort: "minimal" })).toEqual({});
  });

  test("absent effort → NO --effort", () => {
    expect(claudeModelEffort({})).toEqual({});
  });

  test("model + effort together (anthropic, high)", () => {
    expect(
      claudeModelEffort({
        provider: "anthropic",
        model: "anthropic/claude-opus-4-8",
        effort: "high",
      }),
    ).toEqual({ model: "claude-opus-4-8", effort: "high" });
  });
});

// ─── P1.2: the pure permission transform (Q2) ────────────────────────────────
describe("claudePermission — permission-mode floor + allowlist projection", () => {
  test("empty allowlist → permission-mode default, NO allowedTools (no silent widening)", () => {
    expect(claudePermission([])).toEqual({ permissionMode: "default", allowedTools: [] });
  });

  test("['node'] → Bash(node *) with the LOAD-BEARING space", () => {
    expect(claudePermission(["node"])).toEqual({
      permissionMode: "default",
      allowedTools: ["Bash(node *)"],
    });
  });

  test("multiple commands → one Bash(<cmd> *) each, space preserved", () => {
    const out = claudePermission(["node", "git", "ls"]);
    expect(out).toEqual({
      permissionMode: "default",
      allowedTools: ["Bash(node *)", "Bash(git *)", "Bash(ls *)"],
    });
    expect(out.allowedTools).not.toContain("Bash(node*)");
  });
});

// ─── P1.1/P1.2: the claude arm emits --model/--effort/--permission-mode/--allowedTools
describe("buildCliInvocation — claude-code model/effort/permission flags", () => {
  test("--model + --effort follow the stream flags, before --append-system-prompt", () => {
    const inv = buildCliInvocation("claude-code", {
      systemPrompt: "sys",
      history: [userTurn("hi")],
      model: "claude-sonnet-4-6",
      effort: "high",
    });
    expect(inv.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "high",
      "--append-system-prompt",
      "sys",
    ]);
  });

  test("--permission-mode default + --allowedTools with the LOAD-BEARING space", () => {
    const inv = buildCliInvocation("claude-code", {
      history: [userTurn("hi")],
      permissionMode: "default",
      allowedTools: ["Bash(node *)", "Bash(git *)"],
    });
    expect(inv.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "default",
      "--allowedTools",
      "Bash(node *)",
      "Bash(git *)",
    ]);
    // The space before * is preserved per tool token (not Bash(node*)).
    expect(inv.command).toContain("Bash(node *)");
    expect(inv.command).not.toContain("Bash(node*)");
  });

  test("empty allowedTools → NO --allowedTools (no silent widening)", () => {
    const inv = buildCliInvocation("claude-code", {
      history: [userTurn("hi")],
      permissionMode: "default",
      allowedTools: [],
    });
    expect(inv.command).toContain("--permission-mode");
    expect(inv.command).not.toContain("--allowedTools");
  });

  test("codex ignores model/effort/permission flags in v1", () => {
    const inv = buildCliInvocation("codex", {
      history: [userTurn("hi")],
      model: "claude-sonnet-4-6",
      effort: "high",
      permissionMode: "default",
      allowedTools: ["Bash(node *)"],
    });
    expect(inv.command).toEqual(["codex", "exec", "--json", "-"]);
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
