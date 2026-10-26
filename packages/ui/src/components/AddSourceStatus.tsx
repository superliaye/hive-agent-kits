import type { AddSourceError, AddSourceResult } from "../api.ts";

// The outcome banner for one add-Source request, by URL or by Tile.
export function AddSourceStatus({
  state,
}: {
  state: {
    isPending: boolean;
    isError: boolean;
    error: AddSourceError | null;
    data: AddSourceResult | undefined;
  };
}): JSX.Element | null {
  if (state.isPending) {
    return (
      <div className="add-source-status meta" data-testid="add-source-pending">
        Adding &amp; syncing…
      </div>
    );
  }
  if (state.isError && state.error) {
    return (
      <div className="banner-error add-source-status" data-testid="add-source-error">
        {addSourceErrorMessage(state.error)}
      </div>
    );
  }
  const result = state.data;
  if (!result) return null;
  if (result.sync.errorReason === "not_recognized") {
    return (
      <div className="banner-warn add-source-status" data-testid="add-source-not-recognized">
        Added {result.source.label} — Hive does not recognize it, so nothing will deploy
        {result.sync.errorDetail ? `: ${result.sync.errorDetail}` : "."}
      </div>
    );
  }
  if (!result.validation.conformant) {
    const count = result.validation.errors.length;
    return (
      <div className="banner-warn add-source-status" data-testid="add-source-warning">
        Added {result.source.label} — {count} conformance problem{count === 1 ? "" : "s"}; nothing
        will deploy until fixed.
      </div>
    );
  }
  if (result.validation.capabilityCount === 0) {
    return (
      <div className="banner-info add-source-status" data-testid="add-source-empty">
        Added {result.source.label} — no capabilities found.
      </div>
    );
  }
  return (
    <div className="banner-success add-source-status" data-testid="add-source-success">
      Added {result.source.label} — {result.validation.capabilityCount}{" "}
      {result.validation.capabilityCount === 1 ? "capability" : "capabilities"}.
    </div>
  );
}

function addSourceErrorMessage(error: AddSourceError): string {
  const cause = error.cause;
  if (cause.kind === "invalid") {
    return cause.issues.length > 0
      ? cause.issues.map((issue) => issue.message).join("; ")
      : "Invalid Source.";
  }
  if (cause.kind === "duplicate") return `Already added: ${cause.origin}`;
  if (cause.kind === "malformed-success")
    return "Source added, but the response could not be read — refresh to see it.";
  return cause.message;
}
