// Canonical conversation message vocabulary — Anthropic-flavored content blocks.
//
// These are cross-cutting primitives shared by KEPT modules (Threads, the runs
// resolver chain, the server HTTP boundary) that have no dependency on any one
// backend. They live in `lib/` (alongside `ids.ts`, `capability-types.ts`) so
// the message shape outlives the deletion of the old ModelGateway: re-homing it
// here keeps Threads/server compiling without coupling them to the runs/backends
// module.

export type JsonSchema = Record<string, unknown>;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "image";
      source: { type: "base64" | "url"; media_type?: string; data: string };
    };

export type Message = {
  role: "user" | "assistant";
  content: ContentBlock[];
};
