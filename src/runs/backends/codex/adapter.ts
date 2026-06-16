// Codex backend adapter — STUB (P1.2). Satisfies `BackendRun` and emits a
// terminal `run.completed` only, so `dispatch` is exercisable end-to-end before
// the real codex-sdk fold (P4) lands. The real adapter folds the
// `ThreadEvent`/`ThreadItem` stream into RunEvents (see options.ts + the P4 fold).

import { Stream } from "effect";
import type { ThreadMessage } from "../../../threads/types.ts";
import type { RunEvent } from "../../types.ts";
import type { BackendError } from "../errors.ts";
import type { BackendInvocation } from "../invocation.ts";
import type { BackendRun } from "../port.ts";

export type CodexAdapterDeps = {
  now?: () => number;
};

export function createCodexAdapter(deps: CodexAdapterDeps = {}): BackendRun {
  const now = deps.now ?? Date.now;
  return {
    run(invocation: BackendInvocation): Stream.Stream<RunEvent, BackendError> {
      const { runId, threadId } = invocation;
      const finalMessage: ThreadMessage = {
        id: crypto.randomUUID(),
        threadId,
        idx: 0,
        role: "assistant",
        content: [{ type: "text", text: "[codex stub]" }],
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
