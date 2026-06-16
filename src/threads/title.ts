// Best-effort auto-title generation for a Thread (Q-title, BINDING).
//
// Called from the run route after a terminal `run.completed`. Generates a short
// title from the thread's conversation history (once it has at least one
// completed exchange, backfilling on a later exchange if an earlier title-gen
// failed) via a ONE-SHOT, NON-STREAMED Claude SDK query, then writes it through
// `setTitle(..., "auto")` (sticky: a manual title is never clobbered; auto writes
// emit NO audit row by construction).
//
// Plain-async I/O-edge helper (AGENTS.md "plain async only at I/O edges"): it
// drains the Claude SDK query to text. EVERYTHING is wrapped in try/catch; any
// throw is traced and swallowed — a title-gen failure must never fail the Run.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AuthInput } from "../lib/auth.ts";
import { log } from "../lib/log.ts";
import type { Message } from "../lib/messages.ts";
import type { RunnableCatalogPort } from "../runs/effect/ports.ts";
import { resolveAgentModel } from "../runs/resolve-model.ts";

// Fixed instruction. Kept terse — the model summarizes the conversation into a
// short, plain title with no surrounding quotes or punctuation.
const TITLE_SYSTEM_PROMPT =
  "Summarize this conversation into a concise title of at most 6 words. " +
  "Respond with the title only — no quotes, no trailing punctuation, no preamble.";

// Narrow, consumer-owned ports — only the verbs title-gen actually calls.
type ThreadsPort = {
  get(
    threadId: string,
  ): { agentId: string; title: string | null; titleSource: "auto" | "manual" } | undefined;
  getCompletionMessages(threadId: string): Message[];
  setTitle(threadId: string, title: string, source: "auto"): Promise<void>;
};

type RunsPort = {
  listByThread(threadId: string): Array<{ status: string }>;
};

type CatalogPort = {
  get(agentId: string): { config: Record<string, unknown> } | undefined;
};

type SecretsPort = {
  getAuth(provider: string): Promise<AuthInput | undefined>;
};

type AgentModelPrefsPort = {
  getModel(agentId: string): string | undefined;
};

export type MaybeGenerateTitleDeps = {
  threads: ThreadsPort;
  runs: RunsPort;
  catalog: CatalogPort;
  secrets: SecretsPort;
  agentModelPrefs: AgentModelPrefsPort;
  runnableCatalog?: RunnableCatalogPort;
};

// Render the conversation history as a single prompt the one-shot query
// summarizes. Only text blocks are carried (a title needs the words, not the
// tool plumbing); each message is tagged with its role.
function renderHistory(messages: Message[]): string {
  return messages
    .map((m) => {
      const text = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return text.length > 0 ? `${m.role}: ${text}` : "";
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export async function maybeGenerateTitle(
  deps: MaybeGenerateTitleDeps,
  threadId: string,
): Promise<void> {
  try {
    const { threads, runs, catalog, secrets, agentModelPrefs, runnableCatalog } = deps;

    // Guard 1: only untitled auto threads. A manual title is sticky.
    const t = threads.get(threadId);
    if (!t || t.title !== null || t.titleSource !== "auto") return;

    // Guard 2: at least one completed exchange (a floor, not an exact count —
    // title-gen retries until the Thread is titled; a failed first attempt
    // backfills on the next completed exchange).
    const completedCount = runs
      .listByThread(threadId)
      .filter((r) => r.status === "completed").length;
    if (completedCount < 1) return;

    // Re-resolve the model the same way the executor does (shared resolver).
    const agent = catalog.get(t.agentId);
    if (!agent) return;
    const resolved = resolveAgentModel({
      configuredModel: typeof agent.config.model === "string" ? agent.config.model : undefined,
      userModelDefault: agentModelPrefs.getModel(t.agentId),
      ...(runnableCatalog !== undefined ? { runnableCatalog: runnableCatalog.snapshot() } : {}),
    });
    // A symbolic default with no runnable model surfaces as a typed failure here;
    // title-gen skips cleanly (best-effort, never fails the Run).
    if ("failure" in resolved) return;
    const { provider } = resolved;

    // Auth: resolve from Secrets when present, else fall back to the Claude SDK's
    // ambient login. Title-gen runs through the Claude SDK regardless of the Run's
    // backend (a cheap one-shot summary).
    const auth = await secrets.getAuth(provider);

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (auth?.kind === "apiKey") env.ANTHROPIC_API_KEY = auth.apiKey;

    const conversation = renderHistory(threads.getCompletionMessages(threadId));
    if (conversation.length === 0) {
      log().warn({ module: "threads/title", threadId }, "title-gen skipped: empty conversation");
      return;
    }

    // ONE-SHOT, NON-STREAMED: drain the query to text. No tools, bypass perms.
    let title = "";
    for await (const message of query({
      prompt: conversation,
      options: {
        executable: "bun",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: TITLE_SYSTEM_PROMPT,
        env,
      },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        title = message.result;
      }
    }

    const trimmed = title.trim();
    if (trimmed.length === 0) {
      log().warn({ module: "threads/title", threadId }, "title-gen skipped: empty completion");
      return;
    }

    await threads.setTitle(threadId, trimmed, "auto");
  } catch (err) {
    log().warn({ module: "threads/title", threadId, err }, "title-gen failed");
  }
}
