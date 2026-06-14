// Pure CLI-invocation assembly — turns a Run's Thread-derived prompt + projected
// systemPrompt + create/resume mode into the `{ command, stdin }` a
// CliSpawnerPort consumes. No subprocess, no I/O: testable in isolation
// (ADR-0016 "config is assembled, not authored").
//
// Each CLI runs in JSON-STREAM mode so the dispatch arm can BOTH capture the
// CLI's native session id AND stream assistant text:
//   - claude-code: `-p --output-format stream-json --verbose`; session id from
//     the init event, assistant text from assistant events, done from result.
//   - codex: `exec --json`; session id is the `thread.started` event's
//     `thread_id`.
// CREATE starts a fresh native session; RESUME re-attaches the CLI to its own
// on-disk history by the stored id (claude `--resume <id>`, codex
// `exec resume <id>`), so only the latest user turn is sent — the CLI replays
// the rest. The prompt rides STDIN (not argv) to avoid OS argv-length limits and
// shell-quoting, and to dodge the documented `codex exec "<arg>"` non-TTY-stdin
// hang (openai/codex#20919) — stdin EOF is the prompt boundary.

import type { AgentBackend } from "../../lib/capability-types.ts";
import type { Message, ThinkingEffort } from "../../model-gateway/types.ts";

export type CliInvocation = {
  command: string[];
  stdin?: string;
};

// claude-code's `--effort` choices (v2.1.177): {low, medium, high, xhigh, max}.
// Hive's intersection with `ThinkingEffort` (EFFORT_ORDER) is exactly
// {low, medium, high, xhigh}. `off`/`minimal` have no claude equivalent (→ CLI
// default, no flag); `max` is unreachable from Hive (no Hive level maps to it).
const CLAUDE_EFFORT_LEVELS: ReadonlySet<ThinkingEffort> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
]);

// PURE transform from Hive's resolved (provider, model, effort) to the bare
// claude-code `--model`/`--effort` values (P1.1, Q1). NOT a passthrough: neither
// the model string nor the effort set is wire-compatible.
//   - Model: `--model` ONLY when provider === "anthropic", using the BARE
//     Anthropic-direct id (the `provider/` prefix is Bedrock/Vertex-only and
//     meaningless to a direct claude-code invocation). A non-anthropic provider
//     omits `--model` (a cross-provider id is meaningless to claude).
//   - Effort: mapped over the {low,medium,high,xhigh} intersection, 1:1. Each
//     level is GUARDED individually (per-level membership), so an off/minimal
//     value omits `--effort` (→ CLI default) and a non-intersection value is
//     never forwarded. Accepted levels are model-dependent, so the CLI MAY still
//     reject a forwarded level — this never blindly passes the whole set.
export function claudeModelEffort(input: {
  provider?: string;
  /** The Run's resolved model as `provider/model` (resolve() output). */
  model?: string;
  effort?: ThinkingEffort;
}): { model?: string; effort?: ThinkingEffort } {
  const out: { model?: string; effort?: ThinkingEffort } = {};
  if (input.provider === "anthropic" && input.model !== undefined) {
    out.model = stripProviderPrefix(input.model);
  }
  if (input.effort !== undefined && CLAUDE_EFFORT_LEVELS.has(input.effort)) {
    out.effort = input.effort;
  }
  return out;
}

// Drop the leading `provider/` segment from a `provider/model` id, yielding the
// bare model id (e.g. `anthropic/claude-sonnet-4-6` → `claude-sonnet-4-6`). A
// string with no `/` is returned unchanged.
function stripProviderPrefix(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

// Create a fresh CLI session, or resume the CLI's own on-disk session by id.
export type CliInvocationMode = { kind: "create" } | { kind: "resume"; sessionId: string };

export type BuildCliInvocationInput = {
  /** The Run's projected instructions (Agent promptBody + N3 skill listing). */
  systemPrompt?: string;
  /** Thread completion history — the latest `role:"user"` entry is the prompt. */
  history: readonly Message[];
  /** Create a new native session, or resume a stored one. Default: create. */
  mode?: CliInvocationMode;
  /**
   * Hive-owned projection root holding `.claude/skills/<name>/` (C3). When set,
   * the claude-code arm adds `--add-dir <addDir>` so the CLI's own loader
   * discloses the projected skills. The codex arm ignores it in v1 (Q3).
   */
  addDir?: string;
  /**
   * The BARE model id for `--model` (claude-code only, P1.1/Q1) — already
   * provider-stripped and provider-gated by `claudeModelEffort`. Absent ⇒ no
   * `--model` (CLI default). codex ignores it in v1.
   */
  model?: string;
  /**
   * The mapped thinking-effort level for `--effort` (claude-code only,
   * P1.1/Q1) — already intersection-mapped by `claudeModelEffort`. Absent ⇒ no
   * `--effort` (CLI default). codex ignores it in v1.
   */
  effort?: ThinkingEffort;
  /**
   * The claude `--permission-mode` floor (P1.2/Q2). The dispatch arm passes
   * `"default"` — the ask-on-unapproved floor mirroring Hive's deny-by-default
   * native posture. Absent ⇒ no flag (CLI default). codex ignores it in v1.
   */
  permissionMode?: string;
  /**
   * `--allowedTools` entries projected from the Agent's `commandAllowlist`
   * (P1.2/Q2), each a `Bash(<cmd> *)` string (the space before `*` is
   * load-bearing). Empty/absent ⇒ no `--allowedTools` (CLI stays at its asking
   * default; it does NOT silently widen). codex ignores it in v1.
   */
  allowedTools?: readonly string[];
};

// Flatten a user message's text blocks to a single string. Non-text blocks
// (images / tool_result) aren't expected on a fresh user turn — drop them.
export function flattenUserText(message: Message): string {
  return message.content
    .filter((b): b is Extract<Message["content"][number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// The prompt text = the latest `role:"user"` message's flattened text. The user
// message is appended before the dispatch switch, so it is the last user entry.
function latestUserText(history: readonly Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === "user") return flattenUserText(m);
  }
  return "";
}

export function buildCliInvocation(
  backend: Extract<AgentBackend, "claude-code" | "codex">,
  input: BuildCliInvocationInput,
): CliInvocation {
  const promptText = latestUserText(input.history);
  const systemPrompt = input.systemPrompt;
  const mode = input.mode ?? { kind: "create" };

  switch (backend) {
    case "claude-code": {
      // JSON-stream mode. systemPrompt → `--append-system-prompt`; prompt on
      // stdin. No `--bare`: default mode lets the CLI use its own auth +
      // repo-local config (ADR-0016). RESUME appends `--resume <id>`.
      const command = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
      // Resolved model/effort (P1.1): bare `--model` (anthropic-only) and the
      // intersection-mapped `--effort`. Both already transformed by
      // `claudeModelEffort`; absent ⇒ CLI default. Placed first after the stream
      // flags for deterministic argv-equality tests.
      if (input.model !== undefined) command.push("--model", input.model);
      if (input.effort !== undefined) command.push("--effort", input.effort);
      // Permission contract (P1.2): the `--permission-mode` floor + the
      // allowlist-projected `--allowedTools` entries. Each tool string is a
      // distinct argv token so the load-bearing space in `Bash(<cmd> *)` is
      // preserved (not shell-split). Empty allowlist ⇒ no `--allowedTools`.
      if (input.permissionMode !== undefined) {
        command.push("--permission-mode", input.permissionMode);
      }
      if (input.allowedTools !== undefined && input.allowedTools.length > 0) {
        command.push("--allowedTools", ...input.allowedTools);
      }
      // Projected skills dir (C3): the CLI's own loader auto-loads
      // `<addDir>/.claude/skills/`. Placed after the stream flags, before
      // --resume/--append-system-prompt for deterministic argv-equality tests.
      if (input.addDir !== undefined) command.push("--add-dir", input.addDir);
      if (mode.kind === "resume") command.push("--resume", mode.sessionId);
      if (systemPrompt !== undefined) command.push("--append-system-prompt", systemPrompt);
      return { command, stdin: promptText };
    }
    case "codex": {
      // `codex exec --json` (CREATE) / `codex exec resume <id> --json` (RESUME)
      // with stdin as the prompt. No system-prompt flag, so fold systemPrompt
      // into the prompt text. The `-` stdin sentinel is implied: stdin EOF marks
      // the prompt boundary.
      const command =
        mode.kind === "resume"
          ? ["codex", "exec", "resume", mode.sessionId, "--json", "-"]
          : ["codex", "exec", "--json", "-"];
      const stdin = systemPrompt !== undefined ? `${systemPrompt}\n\n${promptText}` : promptText;
      return { command, stdin };
    }
  }
}
