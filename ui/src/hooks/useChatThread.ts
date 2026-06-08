// useChatThread — state hook for a single thread's message timeline + the
// current in-flight Run (if any).
//
// Responsibilities:
//   - Load persisted messages from `getThread(threadId)` on mount + when
//     threadId changes.
//   - `sendMessage(content)` opens an SSE stream and accumulates the
//     assistant's content blocks as `model.event`s arrive. The pending
//     blocks render alongside persisted messages until `run.completed`
//     fires, at which point we refresh from the server to pick up the
//     persisted assistant message (this is the source-of-truth read).
//   - `cancel()` aborts the SSE stream + POSTs /runs/:id/cancel so the
//     daemon also stops generation.
//   - Surfaces classified errors (`run.failed`) via `error`.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiConfig,
  type ContentBlock,
  type RunEventWire,
  type ThinkingEffort,
  type ThreadDetail,
  type ThreadMessage,
  api,
} from "../api.ts";

export type PendingBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature?: string }
  | { kind: "tool_use"; id: string; name: string; args: unknown; argsDelta?: string };

export type PendingAssistant = {
  runId: string;
  blocks: PendingBlock[];
};

export type ChatThreadState = {
  loading: boolean;
  loadError: string | null;
  thread: ThreadDetail | null;
  messages: ThreadMessage[];
  pending: PendingAssistant | null;
  runError: { code: string; message: string } | null;
  /**
   * Send a user message. Returns when the SSE stream terminates (run
   * completed / failed / cancelled). Caller should not call again until
   * the prior call resolves. `modelOverride` ("provider/model-id") runs this
   * message on a specific model; `effortOverride` sets the thinking effort.
   * Omit either to use the agent's resolved default.
   */
  sendMessage: (
    content: ContentBlock[],
    modelOverride?: string,
    effortOverride?: ThinkingEffort,
  ) => Promise<void>;
  /** Cancel the in-flight run, if any. */
  cancel: () => void;
  /** Re-fetch the thread (call after external mutations). */
  refresh: () => Promise<void>;
};

type State = {
  loading: boolean;
  loadError: string | null;
  thread: ThreadDetail | null;
  pending: PendingAssistant | null;
  runError: { code: string; message: string } | null;
};

export function useChatThread(apiConfig: ApiConfig, threadId: string | null): ChatThreadState {
  const [state, setState] = useState<State>({
    loading: false,
    loadError: null,
    thread: null,
    pending: null,
    runError: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!threadId) {
      setState((s) => ({ ...s, thread: null, loadError: null }));
      return;
    }
    setState((s) => ({ ...s, loading: true, loadError: null }));
    try {
      const t = await api.getThread(apiConfig, threadId);
      setState((s) => ({ ...s, loading: false, thread: t, loadError: null }));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, loadError: (err as Error).message }));
    }
  }, [apiConfig, threadId]);

  useEffect(() => {
    void refresh();
    // Cancel any in-flight stream when the active thread changes.
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [refresh]);

  const sendMessage = useCallback(
    async (
      content: ContentBlock[],
      modelOverride?: string,
      effortOverride?: ThinkingEffort,
    ): Promise<void> => {
      if (!threadId) {
        throw new Error("sendMessage called with no active thread");
      }
      // Optimistically append the user message so the UI reflects the
      // outgoing turn immediately. The refresh after `run.completed`
      // reconciles against on-disk state.
      setState((s) =>
        s.thread
          ? {
              ...s,
              thread: {
                ...s.thread,
                messages: [
                  ...s.thread.messages,
                  {
                    id: `optimistic-user-${Date.now()}`,
                    idx: s.thread.messages.length,
                    role: "user",
                    content,
                    createdAt: Date.now(),
                  },
                ],
              },
              pending: null,
              runError: null,
            }
          : s,
      );

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await api.startRun(
          apiConfig,
          threadId,
          content,
          (event: RunEventWire) => {
            applyRunEvent(event, setState, runIdRef);
          },
          {
            ...(modelOverride ? { modelOverride } : {}),
            ...(effortOverride ? { effortOverride } : {}),
            signal: controller.signal,
          },
        );
      } catch (err) {
        // AbortError fires on cancel — surface as cancelled error only if
        // the controller wasn't the one we initiated.
        if ((err as Error).name !== "AbortError") {
          setState((s) => ({
            ...s,
            runError: { code: "stream_error", message: (err as Error).message },
            pending: null,
          }));
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }

      // After the stream ends, refresh to pick up the persisted assistant
      // message (which the server appended). Skip on cancel — the partial
      // pending blocks already convey the cancelled state.
      if (!controller.signal.aborted) {
        await refresh();
      }
    },
    [apiConfig, threadId, refresh],
  );

  const cancel = useCallback((): void => {
    abortRef.current?.abort();
    const runId = runIdRef.current;
    if (runId) {
      void api.cancelRun(apiConfig, runId).catch(() => {});
    }
  }, [apiConfig]);

  return {
    loading: state.loading,
    loadError: state.loadError,
    thread: state.thread,
    messages: state.thread?.messages ?? [],
    pending: state.pending,
    runError: state.runError,
    sendMessage,
    cancel,
    refresh,
  };
}

// ─── Reducer-ish helper ─────────────────────────────────────────────────

function applyRunEvent(
  event: RunEventWire,
  setState: React.Dispatch<React.SetStateAction<State>>,
  runIdRef: React.MutableRefObject<string | null>,
): void {
  switch (event.type) {
    case "run.started":
      runIdRef.current = event.runId;
      setState((s) => ({
        ...s,
        pending: { runId: event.runId, blocks: [] },
        runError: null,
      }));
      return;
    case "model.event":
      setState((s) => {
        if (!s.pending) return s;
        return { ...s, pending: applyModelEvent(s.pending, event.event) };
      });
      return;
    case "run.completed":
      runIdRef.current = null;
      // Clear pending; refresh() will pick up the persisted final message.
      setState((s) => ({ ...s, pending: null }));
      return;
    case "run.failed":
      runIdRef.current = null;
      setState((s) => ({
        ...s,
        runError: event.error,
        // Keep pending blocks visible — they show partial output that the
        // user can copy/inspect.
      }));
      return;
    case "run.cancelled":
      runIdRef.current = null;
      setState((s) => ({
        ...s,
        runError: { code: "cancelled", message: "Run cancelled." },
      }));
      return;
  }
}

type ModelEventPayload = Extract<RunEventWire, { type: "model.event" }>["event"];

function applyModelEvent(pending: PendingAssistant, ev: ModelEventPayload): PendingAssistant {
  const blocks = [...pending.blocks];
  switch (ev.type) {
    case "text_start":
      blocks.push({ kind: "text", text: "" });
      return { ...pending, blocks };
    case "text_delta": {
      // Append to the last text block (or create one defensively).
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "text") {
        blocks[blocks.length - 1] = { kind: "text", text: last.text + ev.delta };
      } else {
        blocks.push({ kind: "text", text: ev.delta });
      }
      return { ...pending, blocks };
    }
    case "thinking_start":
      blocks.push({ kind: "thinking", thinking: "" });
      return { ...pending, blocks };
    case "thinking_delta": {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "thinking") {
        blocks[blocks.length - 1] = {
          kind: "thinking",
          thinking: last.thinking + ev.delta,
          ...(last.signature !== undefined && { signature: last.signature }),
        };
      } else {
        blocks.push({ kind: "thinking", thinking: ev.delta });
      }
      return { ...pending, blocks };
    }
    case "thinking_end": {
      const sig =
        ev.providerMetadata && typeof ev.providerMetadata.signature === "string"
          ? (ev.providerMetadata.signature as string)
          : undefined;
      const last = blocks[blocks.length - 1];
      if (sig && last && last.kind === "thinking") {
        blocks[blocks.length - 1] = { ...last, signature: sig };
      }
      return { ...pending, blocks };
    }
    case "tool_use_start":
      blocks.push({ kind: "tool_use", id: ev.id, name: ev.name, args: {} });
      return { ...pending, blocks };
    case "tool_use_delta": {
      // Accumulate raw delta into argsDelta for live display; tool_use_end
      // brings the parsed args.
      const idx = blocks.findIndex((b) => b.kind === "tool_use" && b.id === ev.id);
      if (idx >= 0) {
        const cur = blocks[idx] as Extract<PendingBlock, { kind: "tool_use" }>;
        blocks[idx] = { ...cur, argsDelta: (cur.argsDelta ?? "") + ev.delta };
      }
      return { ...pending, blocks };
    }
    case "tool_use_end": {
      const idx = blocks.findIndex((b) => b.kind === "tool_use" && b.id === ev.id);
      if (idx >= 0) {
        const cur = blocks[idx] as Extract<PendingBlock, { kind: "tool_use" }>;
        blocks[idx] = { ...cur, args: ev.args };
      }
      return { ...pending, blocks };
    }
    // text_end / refusal_delta / server_tool / usage / done / error:
    // not material to the live visual. `error` lifts to run.failed via the
    // executor.
    default:
      return pending;
  }
}
