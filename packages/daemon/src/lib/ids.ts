// Branded nominal id types. A bare string is no longer assignable where a
// RunId/ThreadId/AgentId is expected, so transposing two ids (passing a
// threadId where a runId belongs) is a compile error. Purely type-level: a
// branded value still widens into a plain `string` parameter for free, so only
// the identity-carrying surfaces (domain objects, events, wire DTOs) brand —
// input verbs and single-id lookup params stay `string`.
import { z } from "zod";

export const RunId = z.string().brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

export const ThreadId = z.string().brand<"ThreadId">();
export type ThreadId = z.infer<typeof ThreadId>;

export const AgentId = z.string().brand<"AgentId">();
export type AgentId = z.infer<typeof AgentId>;
