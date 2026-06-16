// BackendInvocation — the resolved, backend-agnostic description of one Run the
// executor hands to a backend adapter (D2). Everything an adapter needs to spawn
// its SDK and fold the stream: the identity triad, the prompt + conversation
// continuity token, the resolved model/effort/auth, the working dir, the bound
// skills to project, and the capability MCP endpoint both backends connect to.
//
// The executor resolves this ONCE (model/effort/backend/auth/cwd) and dispatches
// on `backend`; the adapter never re-derives selection (Hive owns it).

import type { AuthInput } from "../../lib/auth.ts";
import type { Origin } from "../../lib/capability-types.ts";
import type { ThinkingEffort } from "../../lib/effort.ts";
import type { AgentId, RunId, ThreadId } from "../../lib/ids.ts";
import type { Message } from "../../lib/messages.ts";

// A bound skill to project into the backend's native progressive-disclosure
// layout (Claude `plugins` dir; Codex workspace `.agents/skills`). `path` is the
// skill's SKILL.md, whose containing dir is copied; `origin` is carried for
// future workplace-scoping.
export type InvocationSkill = { name: string; path: string; origin: Origin };

// Create vs resume — the SDK's own native session continuity (ADR-0016). On
// resume the adapter replays the SDK's stored session and sends only the new
// message; on create it sends the latest user message (+ projected history) and
// captures a fresh session id to persist.
export type ContinuationMode = { kind: "create" } | { kind: "resume"; sessionId: string };

export type BackendInvocation = {
  runId: RunId;
  threadId: ThreadId;
  agentId: AgentId;
  /** The resolved backend id this invocation dispatches to. */
  backend: "claude-code" | "codex";
  /** The latest user message for this turn (Anthropic-flavored content blocks). */
  userMessage: Message["content"];
  /** Full projected conversation history (used on the first/create turn). */
  history: Message[];
  /** The agent's authored system-prompt body (already trimmed; may be empty). */
  systemPrompt: string;
  /** Resolved Working Directory for this Run (ADR-0016 C4) — the SDK's cwd. */
  cwd: string;
  /** Resolved model as `provider/model` (Hive owns selection). */
  model: string;
  /** Resolved model's provider (e.g. "anthropic", "openai-codex"). */
  provider: string;
  /** Resolved thinking effort, when set; else the provider default applies. */
  effort?: ThinkingEffort;
  /** Provider auth resolved from Secrets, when present. */
  auth?: AuthInput;
  /** The agent's bound skills to project into the backend's native layout. */
  skills: readonly InvocationSkill[];
  /** Create vs resume the SDK's native session (continuity across Runs). */
  mode: ContinuationMode;
  /** The Hive capability MCP server URL both backends connect to. */
  mcpEndpoint: string;
  /** Cancellation — wired to the executor's per-Run AbortController. */
  signal: AbortSignal;
};
