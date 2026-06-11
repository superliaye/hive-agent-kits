// Best-effort auto-title generation for a Thread.
//
// Called from the run route after a terminal `run.completed`. Generates a
// short title from the thread's conversation history (once it has at least one
// completed exchange, backfilling on a later exchange if an earlier title-gen
// failed) via the model gateway, then writes it through `setTitle(..., "auto")`
// (sticky: a manual
// title is never clobbered; auto writes emit NO audit row by construction —
// see store.ts:233 + the auto branch at store.ts:setTitle).
//
// Plain-async I/O-edge helper (AGENTS.md "plain async only at I/O edges"): it
// consumes the gateway's legacy AsyncIterable surface (`complete`) so a typed
// failure arrives in-band as a terminal `error` event — no cast, no out-of-band
// throw to reconcile. EVERYTHING is wrapped in try/catch; any throw is traced
// and swallowed. A title-gen failure must never fail the Run.

import { log } from "../lib/log.ts";
import type { CompletionInput, GatewayEvent } from "../model-gateway/types.ts";
import { resolveAgentModel } from "../runs/resolve-model.ts";
import type { RunnableCatalog } from "../runs/symbolic.ts";

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
  getCompletionMessages(threadId: string): CompletionInput["messages"];
  setTitle(threadId: string, title: string, source: "auto"): Promise<void>;
};

type RunsPort = {
  listByThread(threadId: string): Array<{ status: string }>;
};

type CatalogPort = {
  get(agentId: string): { config: Record<string, unknown> } | undefined;
};

type GatewayPort = {
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;
};

type SecretsPort = {
  getAuth(provider: string): Promise<CompletionInput["auth"] | undefined>;
};

type AgentModelPrefsPort = {
  getModel(agentId: string): string | undefined;
};

// Optional runnable-catalog source so title-gen resolves a SYMBOLIC default
// ("latest") the same way the executor does (ADR-0015 S2 guard). Absent ⇒ a
// symbolic default resolves against an empty catalog → `resolveAgentModel`
// returns a typed failure → title-gen skips cleanly (no crash, no malformed
// model call), which is the existing fail-soft behavior.
type RunnableCatalogPort = {
  snapshot(): RunnableCatalog;
};

export type MaybeGenerateTitleDeps = {
  threads: ThreadsPort;
  runs: RunsPort;
  catalog: CatalogPort;
  gateway: GatewayPort;
  secrets: SecretsPort;
  agentModelPrefs: AgentModelPrefsPort;
  runnableCatalog?: RunnableCatalogPort;
};

export async function maybeGenerateTitle(
  deps: MaybeGenerateTitleDeps,
  threadId: string,
): Promise<void> {
  try {
    const { threads, runs, catalog, gateway, secrets, agentModelPrefs, runnableCatalog } = deps;

    // Guard 1: only untitled auto threads. A manual title is sticky.
    const t = threads.get(threadId);
    if (!t || t.title !== null || t.titleSource !== "auto") return;

    // Guard 2: at least one completed exchange. Evaluated AFTER the run row is
    // marked completed (the route observes `run.completed` only after
    // `runs.complete(...)` persists). This is a floor, not an exact count: it
    // only blocks titling an exchange-less Thread. Guard 1 above
    // (`title === null && titleSource === "auto"`) is the binding idempotency
    // guard — once any title exists, generation stops permanently.
    //
    // Why a floor, not `=== 1`: title-gen retries until the Thread is titled.
    // A first exchange that completed but whose title-gen failed (no auth, empty
    // completion, or gateway error) leaves the Thread untitled, so the next
    // completed exchange backfills the title (self-heal). This makes auto-titling
    // disconnect / transient-failure resilient — see ADR-0014 §2.
    const completedCount = runs
      .listByThread(threadId)
      .filter((r) => r.status === "completed").length;
    if (completedCount < 1) return;

    // Re-resolve the model the same way the executor does (shared resolver):
    // per-agent user default > harness config.model > deployment fallback. There
    // is no per-Run override in this context.
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
    const { model, provider } = resolved;

    const auth = await secrets.getAuth(provider);
    if (!auth) {
      log().warn({ module: "threads/title", threadId, provider }, "title-gen skipped: no auth");
      return;
    }

    const input: CompletionInput = {
      model,
      messages: threads.getCompletionMessages(threadId),
      system: TITLE_SYSTEM_PROMPT,
      auth,
    };

    let title = "";
    for await (const ev of gateway.complete(input)) {
      if (ev.type === "text_delta") title += ev.delta;
      if (ev.type === "error") {
        log().warn(
          { module: "threads/title", threadId, code: ev.code },
          "title-gen skipped: gateway error",
        );
        return;
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
