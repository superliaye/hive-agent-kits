// Thread + Message types. Message reuses the ContentBlock + role union
// from `model-gateway/types.ts` — same canonical Anthropic-flavored
// shape end-to-end. No translation between API layer and storage.

import type { ContentBlock } from "../model-gateway/types.ts";

export type Thread = {
  id: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
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
