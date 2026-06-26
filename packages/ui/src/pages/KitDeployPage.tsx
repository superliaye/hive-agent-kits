// KitDeployPage — the capability deploy-manager (Plan C2).
//
// Full Kit catalog grouped by kind + @-namespace, each row name/description +
// deployed/pending indicator. Header: synced version (short SHA) + freshness
// state (update available / check failed / rate-limited) + Check for updates +
// explicit Deploy. Controls: preset selector (seeds Selection), per-CLI target
// toggles, individual toggles, the Deploy Diff (added/removed/changed incl. the
// CLAUDE.md-replacement warning). Deploy is NEVER automatic.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  AddSourceError,
  type AddSourceResult,
  type ApiConfig,
  api,
  type CapabilityEntry,
  type CapabilityKind,
  type DeployDiff,
  type DeployTarget,
  type Selection,
  type Source,
  type SourceSyncStatus,
  type SyncRunResult,
  type VerifyReport,
  type VerifyStatus,
} from "../api.ts";
import { Skeleton, SkeletonGroup } from "../components/Skeleton.tsx";
import { ToastHost, useToasts } from "../components/Toasts.tsx";
import { signalDeployInFlight } from "../platform/deploy-in-flight.ts";

const KINDS: CapabilityKind[] = ["instruction", "skill", "agent", "plugin", "bundle"];
const KIND_LABEL: Record<CapabilityKind, string> = {
  instruction: "Instructions",
  skill: "Skills",
  agent: "Agents",
  plugin: "Plugins",
  bundle: "Bundles",
};

const KIND_TO_CAP: Record<CapabilityKind, keyof Selection["add"]> = {
  instruction: "instructions",
  skill: "skills",
  agent: "agents",
  plugin: "plugins",
  bundle: "bundles",
};

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

// Short, human-readable origin label (owner/repo for a GitHub URL, else the
// last path segment / host).
function shortOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length >= 2)
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0] ?? url.hostname;
    return url.hostname;
  } catch {
    return origin;
  }
}

// Aggregate one sync run's per-Source outcomes into a single toast. q3a:
// failure DOMINATES — any failed Source surfaces an ERROR toast (never a
// success count); else any synced → a success count; else all unchanged →
// "Up to date". Exported for isolated unit testing of the precedence rule.
export function syncToast(result: SyncRunResult): { kind: "success" | "error"; message: string } {
  const failed = result.sources.filter((s) => s.status === "failed").length;
  if (failed > 0) {
    return { kind: "error", message: `Sync failed for ${failed} Source${failed === 1 ? "" : "s"}` };
  }
  const synced = result.sources.filter((s) => s.status === "synced").length;
  if (synced > 0) {
    return { kind: "success", message: `Synced ${synced} Source${synced === 1 ? "" : "s"}` };
  }
  return { kind: "success", message: "Up to date" };
}

type Freshness = {
  label: string;
  className: string;
};

function freshnessOf(state: string | undefined): Freshness {
  switch (state) {
    case "rate_limited":
      return { label: "Rate-limited", className: "kit-fresh-error" };
    case "check_failed":
      return { label: "Check failed", className: "kit-fresh-error" };
    case "local":
      // The bundled Starter Source: copied from the in-repo package, never fetched
      // — no SHA, no network state. Surface it as bundled, not "Up to date".
      return { label: "Bundled", className: "kit-fresh-ok" };
    default:
      return { label: "Up to date", className: "kit-fresh-ok" };
  }
}

export function KitDeployPage({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const qc = useQueryClient();
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  const catalogQuery = useQuery({
    queryKey: ["kit", "catalog"],
    queryFn: () => api.getKitCatalog(apiConfig),
  });
  const stateQuery = useQuery({
    queryKey: ["kit", "state"],
    queryFn: () => api.getKitState(apiConfig),
  });
  // The authoritative Source list, incl. inactive sources, for the header toggle
  // rows. state.sync is active-only, so a deactivated Source would otherwise vanish
  // and could never be re-enabled in place.
  const sourcesQuery = useQuery({
    queryKey: ["sources"],
    queryFn: () => api.listSources(apiConfig),
  });

  // The concrete per-kind selected name set is the single source of truth.
  // Presets are a convenience tool over it (seed / clear / active-overview), not
  // stored selection — there is no preset provenance to persist (the Ledger
  // records resolved names only), so a preset reads "active" purely by whether
  // all its capabilities are currently selected.
  const [selected, setSelected] = useState<Selection["add"]>(emptyCaps());
  const [targets, setTargets] = useState<DeployTarget[]>(["claude"]);

  const catalog = catalogQuery.data;
  const state = stateQuery.data;

  // Wire selection: presets/remove stay empty — the resolved `selected` set is
  // sent as `add`, which the daemon resolves identically (presets ∪ add − remove).
  const selection: Selection = useMemo(
    () => ({ presets: [], add: selected, remove: emptyCaps(), targets }),
    [selected, targets],
  );

  // On-disk self-check (Feature 1/2): runs on load and is re-fetched after every
  // deploy (the deploy mutation invalidates the ["kit","verify"] key). The row
  // indicator reflects DISK reality, not just the ledger.
  const verifyQuery = useQuery({
    queryKey: ["kit", "verify"],
    queryFn: () => api.getKitVerify(apiConfig),
  });

  // Per-kind, per-name collapsed on-disk status for the row indicator. A
  // capability split across targets collapses to its worst state
  // (drifted > missing > present/recorded) so a single missing/edited target
  // still flags the row.
  const onDisk = useMemo(() => collapseVerify(verifyQuery.data), [verifyQuery.data]);

  // Currently-deployed (ledger-owned) names, for the deployed/pending indicator.
  const deployed = useMemo(() => {
    const ledger = state?.ledger;
    return {
      instruction: new Set((ledger?.instructions ?? []).map((e) => e.name)),
      skill: new Set((ledger?.skills ?? []).map((e) => e.name)),
      agent: new Set((ledger?.agentDefs ?? []).map((e) => e.name)),
      plugin: new Set((ledger?.plugins ?? []).map((e) => e.name)),
      bundle: new Set((ledger?.bundles ?? []).map((e) => e.name)),
    };
  }, [state]);

  // Seed the working selection from the deployed Ledger once the state query
  // first resolves, so the page opens reflecting what is actually deployed rather
  // than blank. User edits then layer on top; the guard keeps a post-deploy
  // refetch from clobbering those edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !stateQuery.isSuccess) return;
    seededRef.current = true;
    const ledger = stateQuery.data?.ledger;
    if (!ledger) return;
    setSelected({
      instructions: ledger.instructions.map((e) => e.name),
      skills: ledger.skills.map((e) => e.name),
      agents: ledger.agentDefs.map((e) => e.name),
      plugins: ledger.plugins.map((e) => e.name),
      bundles: ledger.bundles.map((e) => e.name),
    });
    const seededTargets = ledger.agents.filter(
      (a): a is DeployTarget => a === "claude" || a === "codex",
    );
    if (seededTargets.length > 0) setTargets(seededTargets);
  }, [stateQuery.isSuccess, stateQuery.data]);

  const hasSelection = KINDS.some((k) => selected[KIND_TO_CAP[k]].length > 0);

  const diffQuery = useQuery({
    queryKey: ["kit", "diff", JSON.stringify(selection)],
    queryFn: () => api.kitDiff(apiConfig, selection),
    enabled: Boolean(catalog) && hasSelection,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncKit(apiConfig),
    onSuccess: (result: SyncRunResult) => {
      const { kind, message } = syncToast(result);
      pushToast(kind, message);
    },
    onError: () => pushToast("error", "Sync failed"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["kit"] });
    },
  });

  // Flip a Source on/off. The catalog is server-side active-only, so invalidating
  // ["kit"] re-fetches the catalog (the deactivated Source's capabilities now gone)
  // and ["sources"] flips the row's active state — both live, no manual refresh.
  // Selection is name-based and source-agnostic (ADR-0023): we do NOT prune the
  // `selected` set here — the daemon drops an absent name from the deploy plan.
  const toggleSource = useMutation({
    mutationFn: (s: Source) =>
      s.active ? api.deactivateSource(apiConfig, s.id) : api.activateSource(apiConfig, s.id),
    // The verb is derived from the toggled Source's PRIOR `active` (the mutation
    // variable): an active Source was just deactivated, and vice versa.
    onSuccess: (_data, s: Source) => {
      const label = shortOrigin(s.origin);
      pushToast("success", s.active ? `Deactivated ${label}` : `Activated ${label}`);
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["kit"] });
    },
    // The inline kit-source-toggle-error banner (below) persists the failure;
    // the toast is a transient nudge on top of it.
    onError: () => pushToast("error", "Could not change the Source"),
  });

  // Remove a Source entirely (DELETE /api/sources/:id). Like the toggle, invalidate
  // ["sources"] (the row disappears) + ["kit"] (its capabilities, built from active
  // sources, disappear) so both update live. Already-deployed files are not deleted
  // — an orphaned capability is kept until the user re-deploys.
  const deleteSource = useMutation({
    mutationFn: (s: Source) => api.deleteSource(apiConfig, s.id),
    onSuccess: (_data, s: Source) => {
      pushToast("success", `Removed ${shortOrigin(s.origin)}`);
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["kit"] });
    },
    // The inline kit-source-delete-error banner persists the failure; the toast
    // is a transient nudge on top of it.
    onError: () => pushToast("error", "Could not remove the Source"),
  });

  const deployMutation = useMutation({
    mutationFn: () => api.kitDeploy(apiConfig, selection),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kit", "state"] });
      void qc.invalidateQueries({ queryKey: ["kit", "diff"] });
      // Re-run the on-disk self-check so rows reflect what the deploy just wrote.
      void qc.invalidateQueries({ queryKey: ["kit", "verify"] });
    },
  });

  // Feature 3: signal the Electron main process while a deploy is in flight, so a
  // quit during the deploy prompts a confirm instead of SIGKILLing the daemon
  // mid-write. The signal toggles with the mutation's pending state and is cleared
  // when it settles (incl. on unmount). No-op in a plain browser tab.
  const deployPending = deployMutation.isPending;
  useEffect(() => {
    void signalDeployInFlight(deployPending);
    return () => {
      if (deployPending) void signalDeployInFlight(false);
    };
  }, [deployPending]);

  // A preset is just a tool over the selection: clicking an inactive preset
  // selects all its capabilities; clicking an active one (all selected)
  // deselects them — except any also covered by another still-active preset, so
  // shared capabilities survive and that other preset stays active.
  function togglePreset(name: string): void {
    if (!catalog) return;
    const preset = catalog.presets.find((p) => p.name === name);
    if (!preset) return;
    const allPresets = catalog.presets;
    setSelected((cur) => {
      if (!presetActive(preset, cur)) {
        const next = emptyCaps();
        for (const k of KINDS) {
          const cap = KIND_TO_CAP[k];
          next[cap] = Array.from(new Set([...cur[cap], ...preset.capabilities[cap]]));
        }
        return next;
      }
      const keep = emptyCapSets();
      for (const other of allPresets) {
        if (other.name === name || !presetActive(other, cur)) continue;
        for (const k of KINDS) {
          const cap = KIND_TO_CAP[k];
          for (const n of other.capabilities[cap]) keep[cap].add(n);
        }
      }
      const next = emptyCaps();
      for (const k of KINDS) {
        const cap = KIND_TO_CAP[k];
        const drop = new Set(preset.capabilities[cap].filter((n) => !keep[cap].has(n)));
        next[cap] = cur[cap].filter((n) => !drop.has(n));
      }
      return next;
    });
  }

  function toggleTarget(t: DeployTarget): void {
    setTargets((cur) => {
      if (cur.includes(t)) {
        const next = cur.filter((x) => x !== t);
        return next.length > 0 ? next : cur; // at least one target required
      }
      return [...cur, t];
    });
  }

  function toggleIndividual(kind: CapabilityKind, name: string): void {
    const cap = KIND_TO_CAP[kind];
    setSelected((cur) => {
      const has = cur[cap].includes(name);
      return {
        ...cur,
        [cap]: has ? cur[cap].filter((n) => n !== name) : [...cur[cap], name],
      };
    });
  }

  const sourceStatuses = state?.sync ?? [];
  // Human label per Source id (owner/repo), so a Merge row names its Sources the
  // way the header does — never the opaque sourceId. Falls back to the id when a
  // Source isn't in the freshness array.
  const sourceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sourceStatuses) map.set(s.sourceId, shortOrigin(s.origin));
    return map;
  }, [sourceStatuses]);
  const diff = diffQuery.data;

  // The authoritative row set: the full Source list (incl. inactive) when it has
  // resolved. While the query is loading/errored — or returns a non-array payload
  // — fall back to the active-only state.sync rows (read-only, no toggle) so the
  // header never blanks and never renders a wrong toggle state.
  const sources = Array.isArray(sourcesQuery.data) ? sourcesQuery.data : undefined;
  const anyActiveSource = sources?.some((s) => s.active) ?? false;

  // A removal-bearing Deploy is destructive: it unlinks those capabilities from the
  // CLI homes. The server is authoritative — only a genuinely removable capability
  // (owned, deselected, AND still in the active catalog) reaches the "removed" set
  // (#47); an owned-but-absent orphan never does. Count drives both the plain-
  // language warning and the explicit two-step confirm gate below.
  const removedCount = (diffQuery.data?.entries ?? []).filter((e) => e.change === "removed").length;

  // Two-step confirm: when removedCount>0 the primary Deploy click ARMS the gate
  // (does not fire the mutation); the armed "Confirm" click fires it. With zero
  // removals Deploy fires on the first click (no friction). The armed state is
  // keyed to the exact diff it was armed against (`armedKey === diffKey`), so any
  // selection/target change auto-disarms — a stale confirmation can't fire a
  // different (newly-larger) removal set. No effect needed; it's derived.
  const diffKey = `${JSON.stringify(selection)}|${removedCount}`;
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const deployArmed = armedKey === diffKey;

  // Deploy may only act on a SETTLED diff for the current selection. Mid-refetch
  // `diffQuery.data` is undefined, so `removedCount` reads 0 and the confirm gate
  // would be skipped while the server still deletes (#47 bypass). Gate on this.
  const diffReady = diffQuery.isSuccess && !diffQuery.isFetching;

  function onDeployClick(): void {
    if (!diffReady) return;
    if (removedCount > 0 && !deployArmed) {
      setArmedKey(diffKey);
      return;
    }
    deployMutation.mutate();
  }

  // The add-source input ref lives here so the first-run empty-state CTA can focus
  // it without a DOM query: AddSourceForm receives the ref and the body CTA calls
  // focusAddSource (no forwardRef ceremony, no document.querySelector).
  const addSourceInputRef = useRef<HTMLInputElement>(null);
  function focusAddSource(): void {
    addSourceInputRef.current?.focus();
  }

  // `catalogReady` is the single gate for "show the real catalog body": not the
  // initial-load skeleton, and not the error state. It's also false on a refetch
  // that errored while stale `catalog` data lingers (react-query keeps the last
  // success in `.data`), so the error state never co-renders over a stale catalog.
  const catalogReady = !catalogQuery.isLoading && !catalogQuery.isError;
  const hasEntries = catalogReady && (catalog?.entries.length ?? 0) > 0;
  // Distinguish the all-disabled empty (re-enable a Source above) from the
  // genuinely-first-run / never-synced case. Only meaningful once the catalog has
  // resolved empty.
  const allDisabled =
    catalogReady &&
    catalog?.entries.length === 0 &&
    sources !== undefined &&
    sources.length > 0 &&
    !anyActiveSource;

  return (
    <div className="kit-page" data-testid="kit-deploy-page">
      <header className="kit-header">
        <div className="kit-header-version">
          <h1>Capabilities</h1>
          <div className="kit-sources" data-testid="kit-sources">
            <SourceRows
              sources={sources}
              syncStatuses={sourceStatuses}
              onToggle={(s) => toggleSource.mutate(s)}
              pendingId={toggleSource.isPending ? toggleSource.variables?.id : undefined}
              onDelete={(s) => deleteSource.mutate(s)}
              deletePendingId={deleteSource.isPending ? deleteSource.variables?.id : undefined}
              deleteFailedId={deleteSource.isError ? deleteSource.variables?.id : undefined}
            />
          </div>
          <AddSourceForm apiConfig={apiConfig} inputRef={addSourceInputRef} />
        </div>
        <div className="kit-header-actions">
          <button
            type="button"
            className="button ghost"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            data-testid="kit-check-updates"
          >
            {syncMutation.isPending ? "Checking…" : "Check for updates"}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={onDeployClick}
            disabled={!hasSelection || deployMutation.isPending || (hasSelection && !diffReady)}
            data-testid="kit-deploy"
          >
            {deployMutation.isPending ? "Deploying…" : "Deploy"}
          </button>
          {deployArmed && removedCount > 0 && (
            <button
              type="button"
              className="button danger"
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending}
              data-testid="kit-deploy-confirm"
            >
              Confirm: delete {removedCount} &amp; deploy
            </button>
          )}
        </div>
      </header>

      {removedCount > 0 && (
        <div className="banner-warn kit-deploy-remove-warn" data-testid="kit-deploy-remove-warn">
          Deploy will DELETE {removedCount} installed{" "}
          {removedCount === 1 ? "capability" : "capabilities"} from your CLI home
          {targets.length === 1 ? "" : "s"}. This removes the files — confirm below before
          deploying.
        </div>
      )}

      {hasEntries && (
        <div className="kit-controls">
          <div className="kit-presets" data-testid="kit-presets">
            <span className="kit-control-label">Preset</span>
            {(catalog?.presets ?? []).length === 0 ? (
              <span className="kit-presets-none">none</span>
            ) : (
              (catalog?.presets ?? []).map((p) => (
                <button
                  type="button"
                  key={p.name}
                  className={`badge kit-preset ${presetActive(p, selected) ? "active" : ""}`}
                  onClick={() => togglePreset(p.name)}
                  title={p.description}
                >
                  {p.name}
                </button>
              ))
            )}
          </div>
          <div className="kit-targets" data-testid="kit-targets">
            <span className="kit-control-label">Targets</span>
            {(["claude", "codex"] as DeployTarget[]).map((t) => (
              <label key={t} className="kit-target-toggle">
                <input
                  type="checkbox"
                  checked={targets.includes(t)}
                  onChange={() => toggleTarget(t)}
                  data-testid={`kit-target-${t}`}
                />
                {t === "claude" ? "Claude" : "Codex"}
              </label>
            ))}
          </div>
        </div>
      )}

      {diff && diff.entries.length > 0 && (
        <DeployDiffPanel key={JSON.stringify(selection)} diff={diff} />
      )}

      {deployMutation.isError && (
        <div className="banner-error" data-testid="kit-deploy-error">
          Deploy failed: {(deployMutation.error as Error).message}
        </div>
      )}
      {deployMutation.isSuccess && (!diff || diff.entries.length === 0) && (
        <div className="kit-deploy-ok" data-testid="kit-deploy-ok">
          Deployed. Diff cleared.
        </div>
      )}
      {toggleSource.isError && (
        <div className="banner-error" data-testid="kit-source-toggle-error">
          Could not change the Source — {(toggleSource.error as Error).message}
        </div>
      )}
      {deleteSource.isError && (
        <div className="banner-error" data-testid="kit-source-delete-error">
          Could not remove the Source — {(deleteSource.error as Error).message}
        </div>
      )}

      <div className="kit-catalog" data-testid="kit-catalog">
        {catalogQuery.isLoading && <CatalogSkeleton />}
        {catalogQuery.isError && (
          <div className="kit-catalog-state kit-catalog-error" data-testid="kit-catalog-error">
            <p className="kit-catalog-state-title">Couldn't load the catalog.</p>
            <p className="kit-catalog-state-body">
              The deploy daemon didn't return the catalog. Check that the Hive daemon is running,
              then retry.
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => void catalogQuery.refetch()}
              disabled={catalogQuery.isFetching}
              data-testid="kit-catalog-retry"
            >
              {catalogQuery.isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {catalogReady &&
          catalog?.entries.length === 0 &&
          // Distinguish "every Source is disabled" (re-enable one above) from the
          // genuinely-first-run / no-sources case. The all-disabled message only
          // applies once the source list has resolved with ≥1 entry, none active.
          (allDisabled ? (
            <div className="empty" data-testid="kit-empty-disabled">
              All Sources are disabled — enable one above to see its capabilities.
            </div>
          ) : (
            <div className="kit-catalog-state kit-empty-state" data-testid="kit-empty">
              <p className="kit-catalog-state-title">No capabilities yet.</p>
              <p className="kit-catalog-state-body">
                Hive deploys capabilities from one or more Git Sources into your Claude/Codex homes.
              </p>
              <button
                type="button"
                className="button primary"
                onClick={focusAddSource}
                data-testid="kit-empty-add-source"
              >
                Add a Source
              </button>
            </div>
          ))}
        {catalogReady &&
          KINDS.map((kind) => {
            const entries = (catalog?.entries ?? []).filter((e) => e.kind === kind);
            if (entries.length === 0) return null;
            return (
              <KindSection
                key={kind}
                kind={kind}
                entries={entries}
                selected={new Set(selected[KIND_TO_CAP[kind]])}
                deployed={deployed[kind]}
                onDisk={onDisk[kind]}
                sourceLabels={sourceLabels}
                onToggle={(name) => toggleIndividual(kind, name)}
              />
            );
          })}
      </div>

      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// The per-Source header rows. Renders from the authoritative Source list (incl.
// inactive) when it has resolved, each row carrying an on/off toggle. While the
// list is loading/errored (`sources` undefined) it falls back to the active-only
// `state.sync` rows, read-only (no toggle), so the header never blanks against an
// already-populated catalog and never shows a wrong toggle state.
// Self-contained Add-Source control (mirrors ApiKeyForm): a git-URL input that
// registers a Source via POST /api/sources, plus the inline status beneath it.
// Owns its own mutation + query invalidation so the page body stays thin. The
// daemon onboards (sync + validate) and KEEPS the Source even when non-conformant
// or empty, so on success we always invalidate ["sources"] (new row) + ["kit"]
// (its capabilities, built from active sources); the returned AddSourceResult
// drives the status copy.
function AddSourceForm({
  apiConfig,
  inputRef,
}: {
  apiConfig: ApiConfig;
  // Owned by the parent so the first-run empty-state CTA can focus this input
  // without a DOM query (see focusAddSource in KitDeployPage).
  inputRef: RefObject<HTMLInputElement>;
}): JSX.Element {
  const qc = useQueryClient();
  // Uncontrolled (matches the api-key-form pattern): read on submit, cleared on a
  // successful add. `empty` tracks only emptiness so submit can disable on a blank
  // field without making the input controlled.
  const [empty, setEmpty] = useState(true);

  const addSource = useMutation<AddSourceResult, AddSourceError, string>({
    mutationFn: (origin: string) => api.addSource(apiConfig, origin),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["kit"] });
    },
    onError: (err) => {
      // A malformed 201 still committed the Source server-side — refetch so the
      // new row surfaces even though the body couldn't drive the status banner.
      if (err.cause.kind === "malformed-success") {
        void qc.invalidateQueries({ queryKey: ["sources"] });
        void qc.invalidateQueries({ queryKey: ["kit"] });
      }
    },
  });

  return (
    <>
      <form
        className="add-source-form"
        data-testid="add-source-form"
        onSubmit={(e) => {
          e.preventDefault();
          const origin = inputRef.current?.value.trim() ?? "";
          if (!origin) return;
          addSource.mutate(origin, {
            onSuccess: () => {
              if (inputRef.current) inputRef.current.value = "";
              setEmpty(true);
            },
          });
        }}
      >
        <input
          ref={inputRef}
          type="text"
          placeholder="https://github.com/owner/repo"
          disabled={addSource.isPending}
          onInput={(e) => setEmpty(e.currentTarget.value.trim().length === 0)}
          aria-label="Git URL of a Source to add"
          data-testid="add-source-input"
        />
        <button
          type="submit"
          className="button"
          disabled={addSource.isPending || empty}
          data-testid="add-source-submit"
        >
          {addSource.isPending ? "Adding…" : "Add Source"}
        </button>
      </form>
      <AddSourceStatus state={addSource} />
    </>
  );
}

// Inline status beneath the Add-Source form, scoped to this control (not a toast
// — #50 owns that). Driven by the mutation state + the 201 `validation` body:
// pending → error (parsed AddSourceError) → success / empty / conformance-warning.
// The Source is kept on every 201, so the empty + warning cases are informational,
// not failures.
function AddSourceStatus({
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
  const lbl = shortOrigin(result.source.origin);
  const { validation } = result;
  if (!validation.conformant) {
    const n = validation.errors.length;
    return (
      <div className="banner-warn add-source-status" data-testid="add-source-warning">
        Added {lbl} — {n} conformance problem{n === 1 ? "" : "s"}; nothing will deploy until fixed.
      </div>
    );
  }
  if (validation.capabilityCount === 0) {
    return (
      <div className="banner-info add-source-status" data-testid="add-source-empty">
        Added {lbl} — no capabilities found.
      </div>
    );
  }
  return (
    <div className="banner-success add-source-status" data-testid="add-source-success">
      Added {lbl} — {validation.capabilityCount} capabilit
      {validation.capabilityCount === 1 ? "y" : "ies"}.
    </div>
  );
}

// Render the parsed AddSourceError cause into user copy: 400 → join issue
// messages; 409 → the duplicate origin; malformed-success → an advisory note (the
// Source was added but the response couldn't be read); else → the carried message.
function addSourceErrorMessage(err: AddSourceError): string {
  const cause = err.cause;
  if (cause.kind === "invalid") {
    return cause.issues.length > 0
      ? cause.issues.map((i) => i.message).join("; ")
      : "Invalid source URL.";
  }
  if (cause.kind === "duplicate") {
    return `Already added: ${cause.origin}`;
  }
  if (cause.kind === "malformed-success") {
    return "Source added, but the response could not be read — refresh to see it.";
  }
  return cause.message;
}

function SourceRows({
  sources,
  syncStatuses,
  onToggle,
  pendingId,
  onDelete,
  deletePendingId,
  deleteFailedId,
}: {
  sources: Source[] | undefined;
  syncStatuses: SourceSyncStatus[];
  onToggle: (s: Source) => void;
  // The id of the Source whose toggle is currently mutating, so only that row's
  // control disables — an in-flight toggle on one Source must not freeze the rest.
  pendingId: string | undefined;
  onDelete: (s: Source) => void;
  // The id of the Source whose delete is currently mutating (same per-row scoping
  // as `pendingId`).
  deletePendingId: string | undefined;
  // The id of the Source whose last delete FAILED, so that row auto-disarms its
  // confirm (the error banner above carries the failure; the row returns to its
  // Remove trigger rather than sitting armed).
  deleteFailedId: string | undefined;
}): JSX.Element {
  if (sources === undefined) {
    // Fallback: render the active-only sync rows read-only. The first row keeps the
    // stable bare testids (every sync row is, by definition, an active synced row).
    return (
      <>
        {syncStatuses.map((s, idx) => (
          <SourceRow
            key={s.sourceId}
            id={s.sourceId}
            origin={s.origin}
            sync={s}
            active
            anchor={idx === 0}
          />
        ))}
      </>
    );
  }

  const syncById = new Map(syncStatuses.map((s) => [s.sourceId, s] as const));
  // Stable freshness-testid anchor: the bare `kit-sha`/`kit-freshness` go on the
  // FIRST row that has a state.sync entry (the first *synced* row), never raw idx 0
  // — the Starter seeds first in registry order and is SHA-less/deactivatable, so
  // anchoring on position would put the stable testid on a SHA-less row.
  const firstSyncedId = sources.find((s) => syncById.has(s.id))?.id;
  return (
    <>
      {sources.map((s) => (
        <SourceRow
          key={s.id}
          id={s.id}
          origin={s.origin}
          kind={s.kind}
          sync={syncById.get(s.id)}
          active={s.active}
          anchor={s.id === firstSyncedId}
          onToggle={() => onToggle(s)}
          togglePending={pendingId === s.id}
          onDelete={() => onDelete(s)}
          deletePending={deletePendingId === s.id}
          deleteFailed={deleteFailedId === s.id}
        />
      ))}
    </>
  );
}

// A single Source header row. With `onToggle` present it renders an on/off toggle
// bound to `active`; without it (the loading fallback) it is read-only. SHA +
// freshness render only for an active, currently-synced Source; an inactive row
// is muted and shows origin only. The bare `kit-sha`/`kit-freshness` testids land
// on the `anchor` (first synced) row; every other synced row gets the `-<id>`
// suffix; un-synced/inactive rows carry no SHA/freshness testid at all.
//
// The delete control renders only with `onDelete` AND `kind !== "local"`: the
// bundled Starter is system-seeded, never user-added (ADR-0023), so a user-facing
// Remove affordance does not apply to it (it is re-copied from the in-repo package
// on every app update). Delete is destructive (drops the Source + Mirror + catalog
// entries) so it is gated by a two-step inline confirm.
function SourceRow({
  id,
  origin,
  kind,
  sync,
  active,
  anchor,
  onToggle,
  togglePending,
  onDelete,
  deletePending,
  deleteFailed,
}: {
  id: string;
  origin: string;
  kind?: Source["kind"];
  sync: SourceSyncStatus | undefined;
  active: boolean;
  anchor: boolean;
  onToggle?: () => void;
  togglePending?: boolean;
  onDelete?: () => void;
  deletePending?: boolean;
  deleteFailed?: boolean;
}): JSX.Element {
  const fresh = sync ? freshnessOf(sync.state) : null;
  // Two-step inline confirm: the first "Remove" click arms (reveals Confirm +
  // Cancel) without firing; the armed Confirm click calls onDelete. A SUCCESSFUL
  // delete unmounts this row (its Source leaves the refetched list), discarding
  // this state; a FAILED delete keeps the row, so disarm on failure (below) so it
  // returns to the Remove trigger rather than sitting armed.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (deleteFailed) setConfirming(false);
  }, [deleteFailed]);
  const deletable = onDelete && kind !== "local";
  return (
    <div
      className={`kit-source-row ${active ? "" : "kit-source-row-inactive"}`}
      data-testid={`kit-source-${id}`}
    >
      <span className="kit-source-origin" title={origin}>
        {shortOrigin(origin)}
      </span>
      {sync && fresh && (
        <>
          <span
            className="kit-sha"
            data-testid={anchor ? "kit-sha" : `kit-sha-${id}`}
            title={sync.sha ?? ""}
          >
            {shortSha(sync.sha)}
          </span>
          <span
            className={`kit-fresh ${fresh.className}`}
            data-testid={anchor ? "kit-freshness" : `kit-freshness-${id}`}
          >
            {fresh.label}
          </span>
          {sync.rateLimitReset !== undefined && (
            <span className="kit-rate-reset">
              resets {new Date(sync.rateLimitReset * 1000).toLocaleTimeString()}
            </span>
          )}
        </>
      )}
      {onToggle && (
        <label
          className={`kit-source-toggle ${active ? "on" : "off"}`}
          title={active ? "Deactivate" : "Activate"}
        >
          <input
            type="checkbox"
            className="kit-source-switch"
            checked={active}
            onChange={onToggle}
            disabled={togglePending}
            data-testid={`kit-source-toggle-${id}`}
            aria-label={`${active ? "Deactivate" : "Activate"} ${shortOrigin(origin)}`}
          />
          {/* Visible on/off word so the state never relies on color/opacity alone. */}
          <span className="kit-source-toggle-label" aria-hidden="true">
            {active ? "On" : "Off"}
          </span>
        </label>
      )}
      {deletable &&
        (confirming ? (
          <span className="kit-source-delete-confirm" data-testid={`kit-source-delete-arm-${id}`}>
            <span className="kit-source-delete-prompt">Remove?</span>
            <button
              type="button"
              className="kit-source-delete-go"
              onClick={() => onDelete?.()}
              disabled={deletePending}
              title="Removes this Source and its capabilities from the catalog. Already-deployed files stay until you re-deploy."
              data-testid={`kit-source-delete-confirm-${id}`}
            >
              {deletePending ? "Removing…" : "Remove"}
            </button>
            {/* Cancel only flips local UI state, so it stays enabled even while
                the delete is in flight — a hung request must never trap the user. */}
            <button
              type="button"
              className="kit-source-delete-cancel"
              onClick={() => setConfirming(false)}
              data-testid={`kit-source-delete-cancel-${id}`}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="kit-source-delete"
            onClick={() => setConfirming(true)}
            title="Remove this Source"
            aria-label={`Remove ${shortOrigin(origin)}`}
            data-testid={`kit-source-delete-${id}`}
          >
            Remove
          </button>
        ))}
    </div>
  );
}

// Content-shaped placeholder for the loading catalog: a couple of skeleton
// "kind sections" (title + a few rows) mirroring .kit-kind → .kit-row.
function CatalogSkeleton(): JSX.Element {
  // Two skeleton kind-sections, identified by stable synthetic names so the
  // placeholder rows carry non-index keys.
  const sections = [
    { id: "a", rows: ["a1", "a2", "a3"] },
    { id: "b", rows: ["b1", "b2"] },
  ];
  return (
    <SkeletonGroup
      label="Loading catalog…"
      testId="kit-catalog-skeleton"
      className="kit-catalog-skeleton"
    >
      {sections.map((section) => (
        <div className="skeleton-kind" key={section.id}>
          <Skeleton width="40%" height="18px" />
          {section.rows.map((rowId) => (
            <div className="skeleton-row" key={rowId}>
              <Skeleton width="16px" height="16px" radius="4px" />
              <div className="skeleton-row-main">
                <Skeleton width="35%" height="13px" />
                <Skeleton width="70%" height="12px" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </SkeletonGroup>
  );
}

function KindSection({
  kind,
  entries,
  selected,
  deployed,
  onDisk,
  sourceLabels,
  onToggle,
}: {
  kind: CapabilityKind;
  entries: CapabilityEntry[];
  selected: Set<string>;
  deployed: Set<string>;
  onDisk: Map<string, VerifyStatus>;
  sourceLabels: Map<string, string>;
  onToggle: (name: string) => void;
}): JSX.Element {
  // Group by @-namespace within the kind.
  const groups = useMemo(() => {
    const map = new Map<string, CapabilityEntry[]>();
    for (const e of entries) {
      const g = e.group || "";
      const arr = map.get(g) ?? [];
      arr.push(e);
      map.set(g, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  // CapabilityKeys with >1 variant (same (kind,name), different ContentSha). A
  // multi-variant row disambiguates its testid by a short contentSha suffix; the
  // common single-variant row keeps the stable bare testid.
  const variantCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    return counts;
  }, [entries]);

  return (
    <section className="kit-kind" data-testid={`kit-kind-${kind}`}>
      <h2 className="kit-kind-title">{KIND_LABEL[kind]}</h2>
      {groups.map(([group, rows]) => (
        <div className="kit-group" key={group || "(root)"}>
          {group && <div className="kit-group-name">{group}</div>}
          {rows.map((e) => {
            const isSelected = selected.has(e.name);
            const isDeployed = deployed.has(e.name);
            const disk = onDisk.get(e.name);
            const indicator = rowIndicator({
              deployable: e.deployable,
              shadowed: e.shadowed,
              isSelected,
              isDeployed,
              disk,
            });
            const blocked = !e.deployable && !e.shadowed;
            const selectable = e.deployable;
            // Multi-variant rows key uniformly on the short contentSha (winner and
            // losers alike) so React keys + testids are unique across ≥3 variants.
            const multi = (variantCount.get(e.name) ?? 1) > 1;
            const shortSha = e.contentSha.slice(0, 8);
            const rowKey = multi ? `${group}/${e.name}/${shortSha}` : `${group}/${e.name}`;
            const rowTestId = multi
              ? `kit-row-${kind}-${e.name}-${shortSha}`
              : `kit-row-${kind}-${e.name}`;
            const indicatorTestId = multi
              ? `kit-indicator-${e.name}-${shortSha}`
              : `kit-indicator-${e.name}`;
            return (
              <button
                type="button"
                key={rowKey}
                className={`kit-row ${isSelected ? "selected" : ""} ${blocked ? "blocked" : ""} ${
                  e.shadowed ? "shadowed" : ""
                }`}
                onClick={() => selectable && onToggle(e.name)}
                disabled={!selectable}
                data-testid={rowTestId}
              >
                <span
                  className={`kit-row-check ${isSelected ? "checked" : ""}`}
                  aria-hidden="true"
                />
                <span className="kit-row-main">
                  <span className="kit-row-name">{e.name}</span>
                  {e.description && <span className="kit-row-desc">{e.description}</span>}
                  {/* Merge labels: the Source(s) providing this variant, by their
                      human owner/repo label (the same the header uses). */}
                  {e.sourceIds.length > 1 && (
                    <span className="kit-row-sources" data-testid={`kit-row-sources-${e.name}`}>
                      {e.sourceIds.map((sid) => (
                        <span className="kit-source-label" key={sid}>
                          {sourceLabels.get(sid) ?? sid}
                        </span>
                      ))}
                    </span>
                  )}
                  {blocked && (
                    <span className="kit-row-blocked">{e.blockedReason ?? "un-deployable"}</span>
                  )}
                </span>
                {indicator && (
                  <span
                    className={`kit-indicator kit-indicator-${indicator}`}
                    data-testid={indicatorTestId}
                    data-status={indicator}
                  >
                    {INDICATOR_LABEL[indicator]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}

// One ordered source of truth for the three change buckets: the summary chips and
// the expanded columns both derive from this, so they never drift in order/label.
// `glyph` prefixes the count chip (+ ~ −); removed is last so its danger reads as
// the climax in both the summary and the columns.
const DIFF_BUCKETS = [
  { tone: "added", label: "Added", glyph: "+", change: "added" },
  { tone: "changed", label: "Changed", glyph: "~", change: "changed" },
  { tone: "removed", label: "Removed", glyph: "−", change: "removed" },
] as const;

function DeployDiffPanel({ diff }: { diff: DeployDiff }): JSX.Element {
  const [open, setOpen] = useState(false);
  const userFileWarning = diff.entries.some((e) => e.replacesUserFile);
  const buckets = DIFF_BUCKETS.map((b) => ({
    ...b,
    entries: diff.entries.filter((e) => e.change === b.change),
  }));
  // Only populated buckets render a column — a one-sided diff isn't marooned among
  // empties. Removed severity outranks added/changed via row-level danger (CSS).
  const populated = buckets.filter((b) => b.entries.length > 0);
  return (
    <div className="kit-diff" data-testid="kit-diff">
      <button
        type="button"
        className="kit-diff-toggle"
        data-testid="kit-diff-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="kit-diff-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="kit-diff-summary" data-testid="kit-diff-summary">
          <span className="kit-diff-summary-title">Deploy diff</span>
          {buckets.map((b) =>
            b.entries.length > 0 ? (
              <span key={b.tone} className={`kit-diff-count-${b.tone}`}>
                {b.glyph}
                {b.entries.length}
              </span>
            ) : null,
          )}
        </span>
      </button>
      {/* Always visible regardless of collapse: a user-authored CLAUDE.md overwrite
          is a destructive-action notice (no separate page-level banner covers it). */}
      {userFileWarning && (
        <div className="banner-error kit-diff-warn" data-testid="kit-diff-userfile-warn">
          This deploy replaces an existing user-authored CLAUDE.md (backed up to
          CLAUDE.md.hive-bak).
        </div>
      )}
      {open && (
        <div className="kit-diff-body">
          <div className="kit-diff-cols">
            {populated.map((b) => (
              <DiffCol key={b.tone} label={b.label} tone={b.tone} entries={b.entries} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffCol({
  label,
  tone,
  entries,
}: {
  label: string;
  tone: string;
  entries: DeployDiff["entries"];
}): JSX.Element {
  return (
    <div className={`kit-diff-col kit-diff-${tone}`} data-testid={`kit-diff-${tone}`}>
      <div className="kit-diff-col-head">
        {label} ({entries.length})
      </div>
      <ul>
        {entries.map((e) => (
          <li key={`${e.kind}/${e.name}`}>
            <span className="kit-diff-kind">{e.kind}</span> {e.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Row indicator states. `blocked` and `duplicate` are the non-deployable states
// (malformed vs precedence-shadowed); the next four are ledger/selection-derived;
// `missing` and `drifted` are the disk-truth states from the verify pass.
type Indicator =
  | "blocked"
  | "duplicate"
  | "deployed"
  | "pending"
  | "removing"
  | "missing"
  | "drifted"
  | "";

const INDICATOR_LABEL: Record<Exclude<Indicator, "">, string> = {
  blocked: "blocked",
  duplicate: "not deployed (duplicate)",
  deployed: "deployed",
  pending: "pending",
  removing: "removing",
  missing: "missing on disk",
  drifted: "drifted",
};

// Fold ledger ownership + working selection + on-disk verify status into one
// indicator. A shadowed variant (lost precedence) reads `duplicate` — a third
// state distinct from `blocked` (malformed). Disk truth WINS for a deployed
// capability: a ledger-owned row whose files were removed reads `missing`; one
// edited since deploy reads `drifted`.
function rowIndicator(args: {
  deployable: boolean;
  shadowed: boolean;
  isSelected: boolean;
  isDeployed: boolean;
  disk: VerifyStatus | undefined;
}): Indicator {
  const { deployable, shadowed, isSelected, isDeployed, disk } = args;
  if (shadowed) return "duplicate";
  if (!deployable) return "blocked";
  if (isDeployed) {
    if (disk === "missing") return "missing";
    if (disk === "drifted") return "drifted";
    if (isSelected) return "deployed";
    return "removing";
  }
  return isSelected ? "pending" : "";
}

// Collapse the per-target verify report into a per-kind, per-name single status.
// Worst-state wins so a row split across targets still flags a problem:
// drifted > missing > present > recorded.
const STATUS_RANK: Record<VerifyStatus, number> = {
  drifted: 3,
  missing: 2,
  present: 1,
  recorded: 0,
};

function collapseVerify(
  report: VerifyReport | undefined,
): Record<CapabilityKind, Map<string, VerifyStatus>> {
  const out: Record<CapabilityKind, Map<string, VerifyStatus>> = {
    instruction: new Map(),
    skill: new Map(),
    agent: new Map(),
    plugin: new Map(),
    bundle: new Map(),
  };
  if (!report) return out;
  for (const e of report.entries) {
    let worst: VerifyStatus | undefined;
    for (const t of e.targets) {
      if (!worst || STATUS_RANK[t.status] > STATUS_RANK[worst]) worst = t.status;
    }
    if (worst) out[e.kind].set(e.name, worst);
  }
  return out;
}

// A preset is active iff it has at least one capability and every one is in the
// current selection. Empty presets never read active (nothing to reflect).
function presetActive(
  preset: { capabilities: Selection["add"] },
  selected: Selection["add"],
): boolean {
  let any = false;
  for (const k of KINDS) {
    const cap = KIND_TO_CAP[k];
    const sel = new Set(selected[cap]);
    for (const n of preset.capabilities[cap]) {
      any = true;
      if (!sel.has(n)) return false;
    }
  }
  return any;
}

function emptyCaps(): Selection["add"] {
  return { instructions: [], skills: [], agents: [], plugins: [], bundles: [] };
}

function emptyCapSets(): Record<keyof Selection["add"], Set<string>> {
  return {
    instructions: new Set(),
    skills: new Set(),
    agents: new Set(),
    plugins: new Set(),
    bundles: new Set(),
  };
}
