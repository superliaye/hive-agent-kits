// Thread + Message types. Message reuses the ContentBlock + role union
// from `model-gateway/types.ts` — same canonical Anthropic-flavored
// shape end-to-end. No translation between API layer and storage.

import type { ContentBlock } from "../model-gateway/types.ts";

// `titleSource` records whether `title` was set automatically (the future
// auto-title generator) or by the user. Once `manual`, an `auto` write no-ops
// — a user-chosen title is sticky. `archivedAt` is the single lifecycle
// marker: null = active, non-null = archived. `lastReadAt` drives unread
// derivation (see status.ts). `updatedAt` stays the sort key (last message).
export type Thread = {
  id: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  titleSource: "auto" | "manual";
  lastReadAt: number | null;
  archivedAt: number | null;
  // Conversation-scope model/effort pick (ADR-0015 S1). null = unset (fall
  // through to the agent default at Run resolution). May be a symbolic token
  // ("latest"/"highest"); the resolver concretizes it. The two axes are
  // independent — setting one never clobbers the other.
  modelPref: string | null;
  effortPref: string | null;
  // Per-conversation Working Directory pick (ADR-0016, C4 tier 1). null = unset
  // (fall through to the agent default, then the per-Agent ~/.hive workspace).
  // An open path string; the executor's resolver is the single resolution point.
  workingDir: string | null;
  // Per-conversation Agent-Backend pick (ADR-0015). null = unset (fall through
  // to the agent default). An open backend id; the resolver's `threadBackend`
  // tier is the single resolution point.
  backend: string | null;
  // CLI native-session continuity (ADR-0016). The backend the stored session id
  // belongs to + the CLI's own session id (claude `session_id` / codex
  // `thread_id`). Both null until a CLI backend creates a session. The resolver
  // resumes only when `cliSessionBackend` matches the Run's resolved backend.
  cliSessionBackend: string | null;
  cliSessionId: string | null;
};

export type TitleSource = "auto" | "manual";

// A Thread's stored CLI native-session token (ADR-0016): the backend it belongs
// to + the CLI's own session id. The executor reads this to decide create-vs-
// resume and writes it after a successful create.
export type CliSession = {
  backend: string;
  sessionId: string;
};

export type ThreadMessage = {
  id: string;
  threadId: string;
  idx: number;
  role: "user" | "assistant";
  content: ContentBlock[];
  createdAt: number;
};

export type ThreadWithMessages = Thread & {
  messages: ThreadMessage[];
};

// Events emitted by the Threads store. Audit subscribes via the standard
// pattern (ADR-0004). Payloads carry REFS not values — `thread.title_set`
// carries `titleSource`, never the title string. Only USER/explicit actions
// emit: auto-archive and the future auto-title generator do NOT go through
// this emitter (they are system-initiated → trace, not audit).
export type ThreadEvents = {
  "thread.archived": { threadId: string; agentId: string };
  "thread.deleted": { threadId: string; agentId: string };
  "thread.title_set": { threadId: string; agentId: string; titleSource: "manual" };
  "thread.marked_unread": { threadId: string; agentId: string };
  // A user's per-conversation model/effort pick (ADR-0015 S1) — a USER action,
  // so audited (ADR-0004). Carries whichever axes the write touched; the model
  // id / effort level are non-secret identifiers (same posture as
  // `agent_pref.set`), safe in the payload. A cleared axis (set to null) is
  // named in `cleared` so clear-model and clear-effort stay distinguishable
  // without widening the value fields to `string | null`.
  "thread.scope_set": {
    threadId: string;
    agentId: string;
    model?: string;
    effort?: string;
    workingDir?: string;
    backend?: string;
    cleared?: ("model" | "effort" | "workingDir" | "backend")[];
  };
};
