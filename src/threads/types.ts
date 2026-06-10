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
};

export type TitleSource = "auto" | "manual";

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
};
