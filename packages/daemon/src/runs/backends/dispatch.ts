// Backend dispatch (D2) — a thin branch on the EXISTING resolved backend id, NOT
// model-inferred (Hive owns selection; ADR-0015). `claude-code` → the Claude
// adapter, `codex` → the Codex adapter. No id rename, no model-shape inference.
// The two adapter handles are constructed once at the composition root and passed
// in; `dispatch` only routes.

import type { Stream } from "effect";
import type { RunEvent } from "../types.ts";
import type { BackendError } from "./errors.ts";
import type { BackendInvocation } from "./invocation.ts";
import type { BackendRun } from "./port.ts";

export type BackendAdapters = {
  "claude-code": BackendRun;
  codex: BackendRun;
};

export function dispatch(
  adapters: BackendAdapters,
  invocation: BackendInvocation,
): Stream.Stream<RunEvent, BackendError> {
  return adapters[invocation.backend].run(invocation);
}
