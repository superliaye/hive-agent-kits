// Claude backend adapter — STUB (P1.2). Satisfies `BackendRun` and emits a
// terminal `run.completed` only, so `dispatch` is exercisable end-to-end before
// the real claude-agent-sdk fold (P3) lands. The real adapter folds the
// `SDKMessage` union into RunEvents (see options.ts + the P3 fold).

import { Stream } from "effect";
import type { ThreadMessage } from "../../../threads/types.ts";
import type { RunEvent } from "../../types.ts";
import type { BackendError } from "../errors.ts";
import type { BackendInvocation } from "../invocation.ts";
import type { BackendRun } from "../port.ts";

export type ClaudeAdapterDeps = {
  now?: () => number;
};

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): BackendRun {
  const now = deps.now ?? Date.now;
  return {
    run(invocation: BackendInvocation): Stream.Stream<RunEvent, BackendError> {
      const { runId, threadId } = invocation;
      const finalMessage: ThreadMessage = {
        id: crypto.randomUUID(),
        threadId,
        idx: 0,
        role: "assistant",
        content: [{ type: "text", text: "[claude stub]" }],
        createdAt: now(),
      };
      const completed: RunEvent = {
        type: "run.completed",
        runId,
        finishReason: "stop",
        finalMessage,
        ts: now(),
      };
      return Stream.make(completed);
    },
  };
}
