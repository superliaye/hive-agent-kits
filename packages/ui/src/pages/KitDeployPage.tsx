import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  AddSourceError,
  type AddSourceResult,
  type ApiConfig,
  api,
  type CapabilityKind,
  type DeploymentOverview,
  type DeployTarget,
  type OverviewLastAttempt,
  type OverviewMirror,
  type OverviewRow,
  type OverviewSource,
  PlanStaleError,
  type ReconciliationState,
  SelectionConflictError,
  type SyncRunResult,
  type TargetObservation,
} from "../api.ts";
import { Skeleton, SkeletonGroup } from "../components/Skeleton.tsx";
import { ToastHost, useToasts } from "../components/Toasts.tsx";
import { useDeveloperConfig } from "../components/useDeveloperConfig.ts";
import { signalDeployInFlight } from "../platform/deploy-in-flight.ts";

const KINDS: CapabilityKind[] = ["instruction", "skill", "agent", "plugin", "bundle"];
const KIND_LABEL: Record<CapabilityKind, string> = {
  instruction: "Instructions",
  skill: "Skills",
  agent: "Agents",
  plugin: "Plugins",
  bundle: "Bundles",
};
const TARGET_LABEL: Record<DeployTarget, string> = { claude: "Claude", codex: "Codex" };
const RECONCILIATION_LABEL: Record<ReconciliationState, string> = {
  in_sync: "In sync",
  pending_add: "Pending add",
  pending_update: "Pending update",
  pending_remove: "Pending removal",
  waiting_for_source: "Waiting for source",
  orphaned: "Source unavailable",
  unmanaged_owned: "Owned outside deployment state",
  manual_install_required: "Manual install required",
  manual_removal_required: "Manual removal required",
};
const OBSERVATION_LABEL: Record<TargetObservation, string> = {
  verified: "Verified",
  present_unverified: "Present, not verified",
  missing: "Missing",
  drifted: "Drifted",
  recorded_unverified: "Recorded, not verified",
  verification_error: "Verification error",
};

type DiffChange = "added" | "changed" | "removed";
type SelectionAttempt = { row: OverviewRow; expectedRevision: number };
type DeployAttempt = {
  selectionRevision: number;
  planToken: string;
  baselineOperationIds: string[];
};
type AmbiguousDeploy = DeployAttempt & {
  overviewUpdatedAt: number;
};

const DIFF_BUCKETS: Array<{ change: DiffChange; label: string; glyph: string }> = [
  { change: "added", label: "Added", glyph: "+" },
  { change: "changed", label: "Changed", glyph: "~" },
  { change: "removed", label: "Removed", glyph: "−" },
];

function shortIdentity(identity: string | null): string {
  return identity ? identity.slice(0, 7) : "no identity";
}

function operationAfter(
  overview: DeploymentOverview,
  attempt: Pick<DeployAttempt, "baselineOperationIds" | "selectionRevision" | "planToken">,
): NonNullable<DeploymentOverview["activeOperation"]> | null {
  const baseline = new Set(attempt.baselineOperationIds);
  const matches = (operation: NonNullable<DeploymentOverview["activeOperation"]>): boolean =>
    !baseline.has(operation.operationId) &&
    operation.selectionRevision === attempt.selectionRevision &&
    operation.planToken === attempt.planToken;
  if (overview.activeOperation && matches(overview.activeOperation)) {
    return overview.activeOperation;
  }
  if (overview.lastOperation && matches(overview.lastOperation)) {
    return overview.lastOperation;
  }
  return null;
}

export function syncToast(result: SyncRunResult): { kind: "success" | "error"; message: string } {
  const failed = result.sources.filter((source) => source.status === "failed").length;
  if (failed > 0) {
    return { kind: "error", message: `Sync failed for ${failed} Source${failed === 1 ? "" : "s"}` };
  }
  const synced = result.sources.filter((source) => source.status === "synced").length;
  return synced > 0
    ? { kind: "success", message: `Synced ${synced} Source${synced === 1 ? "" : "s"}` }
    : { kind: "success", message: "Up to date" };
}

export function KitDeployPage({
  apiConfig,
  connection,
}: {
  apiConfig: ApiConfig;
  connection?: NonNullable<Window["__hive"]>["connection"];
}): JSX.Element {
  const queryClient = useQueryClient();
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const [acceptedOperationId, setAcceptedOperationId] = useState<string | null>(null);
  const [armedPlanToken, setArmedPlanToken] = useState<string | null>(null);
  const [staleSelectionRevision, setStaleSelectionRevision] = useState<number | null>(null);
  const [stalePlanToken, setStalePlanToken] = useState<string | null>(null);
  const [ambiguousDeploy, setAmbiguousDeploy] = useState<AmbiguousDeploy | null>(null);
  const [selectionConflictResolved, setSelectionConflictResolved] = useState(false);
  const [planStaleResolved, setPlanStaleResolved] = useState(false);
  const [transportAcceptanceProven, setTransportAcceptanceProven] = useState(false);
  const addSourceInputRef = useRef<HTMLInputElement>(null);
  const { armed: realHomeArmed } = useDeveloperConfig(apiConfig);

  const overviewQuery = useQuery({
    queryKey: ["kit", "overview"],
    queryFn: () => api.getKitOverview(apiConfig),
    refetchOnReconnect: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      if (connection?.status === "reauthentication_required") return false;
      if (
        acceptedOperationId !== null ||
        query.state.data?.activeOperation ||
        staleSelectionRevision !== null ||
        stalePlanToken !== null ||
        ambiguousDeploy !== null
      ) {
        return 750;
      }
      return connection?.status === "disconnected" ? 15_000 : 10_000;
    },
  });
  const overview = overviewQuery.data;

  useEffect(() => {
    if (!acceptedOperationId || !overview) return;
    const operation =
      overview.activeOperation?.operationId === acceptedOperationId
        ? overview.activeOperation
        : overview.lastOperation?.operationId === acceptedOperationId
          ? overview.lastOperation
          : null;
    if (operation && !["queued", "running"].includes(operation.state)) {
      setAcceptedOperationId(null);
    }
  }, [acceptedOperationId, overview]);

  const operationInFlight = Boolean(acceptedOperationId || overview?.activeOperation);
  useEffect(() => {
    void signalDeployInFlight(operationInFlight);
    return () => {
      if (operationInFlight) void signalDeployInFlight(false);
    };
  }, [operationInFlight]);

  const refetchOverview = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["kit", "overview"] });
  };

  const syncMutation = useMutation({
    mutationFn: () => api.syncKit(apiConfig),
    onSuccess: (result: SyncRunResult) => {
      const toast = syncToast(result);
      pushToast(toast.kind, toast.message);
    },
    onError: () => pushToast("error", "Sync failed"),
    onSettled: refetchOverview,
  });

  const toggleSource = useMutation({
    mutationFn: (source: OverviewSource) =>
      source.active
        ? api.deactivateSource(apiConfig, source.id)
        : api.activateSource(apiConfig, source.id),
    onSuccess: (_result, source) => {
      pushToast("success", `${source.active ? "Deactivated" : "Activated"} ${source.label}`);
      refetchOverview();
    },
    onError: () => pushToast("error", "Could not change the Source"),
  });

  const deleteSource = useMutation({
    mutationFn: (source: OverviewSource) => api.deleteSource(apiConfig, source.id),
    onSuccess: (_result, source) => {
      pushToast("success", `Removed ${source.label}`);
      refetchOverview();
    },
    onError: () => pushToast("error", "Could not remove the Source"),
  });

  const reorderSource = useMutation({
    mutationFn: (input: { source: OverviewSource; direction: "up" | "down" }) =>
      api.reorderSource(apiConfig, input.source.id, input.direction),
    onSuccess: (_result, input) => {
      pushToast("success", `Moved ${input.source.label} ${input.direction}`);
      refetchOverview();
    },
    onError: () => pushToast("error", "Could not reorder the Source"),
  });

  const selectionMutation = useMutation({
    mutationFn: ({ row, expectedRevision }: SelectionAttempt) => {
      return api.patchKitSelection(apiConfig, {
        expectedRevision,
        changes: [
          {
            key: row.key,
            enabled: row.desired === "off",
            targets: row.applicableTargets,
          },
        ],
      });
    },
    onMutate: () => setSelectionConflictResolved(false),
    onSuccess: refetchOverview,
    onError: async (error, attempt) => {
      if (error instanceof SelectionConflictError) {
        setStaleSelectionRevision(attempt.expectedRevision);
        await overviewQuery.refetch();
        return;
      }
      refetchOverview();
    },
  });

  const deployMutation = useMutation({
    mutationFn: ({ selectionRevision, planToken }: DeployAttempt) => {
      return api.acceptKitDeploy(apiConfig, {
        selectionRevision,
        planToken,
      });
    },
    onMutate: () => {
      setPlanStaleResolved(false);
      setTransportAcceptanceProven(false);
    },
    onSuccess: (accepted) => {
      setAcceptedOperationId(accepted.operationId);
      setArmedPlanToken(null);
      refetchOverview();
    },
    onError: async (error, attempt) => {
      setArmedPlanToken(null);
      if (error instanceof PlanStaleError) {
        setStalePlanToken(attempt.planToken);
        await overviewQuery.refetch();
        return;
      }

      const ambiguous = {
        baselineOperationIds: attempt.baselineOperationIds,
        selectionRevision: attempt.selectionRevision,
        planToken: attempt.planToken,
        overviewUpdatedAt: overviewQuery.dataUpdatedAt,
      };
      setAmbiguousDeploy(ambiguous);
      const reloaded = await overviewQuery.refetch();
      if (!reloaded.isSuccess || !reloaded.data) return;
      const accepted = operationAfter(reloaded.data, ambiguous);
      if (!accepted) {
        setAmbiguousDeploy(null);
        return;
      }
      setAcceptedOperationId(accepted.operationId);
      setTransportAcceptanceProven(true);
      setAmbiguousDeploy(null);
    },
  });

  useEffect(() => {
    if (
      staleSelectionRevision === null ||
      !overview ||
      overview.selectionRevision <= staleSelectionRevision
    ) {
      return;
    }
    setStaleSelectionRevision(null);
    setSelectionConflictResolved(true);
  }, [overview, staleSelectionRevision]);

  useEffect(() => {
    if (stalePlanToken === null || !overview || overview.planToken === stalePlanToken) return;
    setStalePlanToken(null);
    setPlanStaleResolved(true);
  }, [overview, stalePlanToken]);

  useEffect(() => {
    if (!ambiguousDeploy || !overview) return;
    const accepted = operationAfter(overview, ambiguousDeploy);
    if (accepted) {
      setAcceptedOperationId(accepted.operationId);
      setTransportAcceptanceProven(true);
      setAmbiguousDeploy(null);
      return;
    }
    if (overviewQuery.dataUpdatedAt === ambiguousDeploy.overviewUpdatedAt) return;
    setAmbiguousDeploy(null);
  }, [ambiguousDeploy, overview, overviewQuery.dataUpdatedAt]);

  useEffect(() => {
    if (!selectionConflictResolved || !selectionMutation.isError) return;
    selectionMutation.reset();
    setSelectionConflictResolved(false);
  }, [selectionConflictResolved, selectionMutation.isError, selectionMutation.reset]);

  useEffect(() => {
    if ((!planStaleResolved && !transportAcceptanceProven) || !deployMutation.isError) return;
    deployMutation.reset();
    setPlanStaleResolved(false);
    setTransportAcceptanceProven(false);
  }, [deployMutation.isError, deployMutation.reset, planStaleResolved, transportAcceptanceProven]);

  const removedCount =
    overview?.diff.entries.filter((entry) => entry.change === "removed").length ?? 0;
  const actionable = (overview?.diff.entries.length ?? 0) > 0;
  const deployArmed = overview !== undefined && armedPlanToken === overview.planToken;
  const authorityUnknown =
    staleSelectionRevision !== null ||
    stalePlanToken !== null ||
    ambiguousDeploy !== null ||
    (connection !== undefined && connection.status !== "connected") ||
    overview === undefined ||
    overviewQuery.isError;
  const deployEnabled =
    actionable && !operationInFlight && !deployMutation.isPending && !authorityUnknown;
  const unmanagedInstructionRows =
    overview?.rows.filter(
      (row) => row.key.kind === "instruction" && row.reconciliation === "unmanaged_owned",
    ) ?? [];
  const deployLabel = authorityUnknown
    ? "Waiting for Overview…"
    : operationInFlight
      ? "Deploying…"
      : actionable
        ? "Deploy"
        : unmanagedInstructionRows.length > 0
          ? "Instructions paused"
          : "Up to date";
  const selectedRows = overview?.rows.filter((row) => row.desired === "on") ?? [];
  const selectedTargets = [
    ...new Set(
      selectedRows.flatMap((row) =>
        row.targets.filter((target) => target.desired === "on").map((target) => target.target),
      ),
    ),
  ];
  const manualInstallRows =
    overview?.rows.filter((row) => row.reconciliation === "manual_install_required") ?? [];
  const manualRemovalRows =
    overview?.rows.filter((row) => row.reconciliation === "manual_removal_required") ?? [];
  const blockedInstructionRows =
    overview?.rows.filter(
      (row) =>
        row.key.kind === "instruction" && row.desired === "on" && row.catalog === "unavailable",
    ) ?? [];

  function deploy(): void {
    if (!deployEnabled || !overview) return;
    if (removedCount > 0 && !deployArmed) {
      setArmedPlanToken(overview.planToken);
      return;
    }
    deployMutation.mutate({
      selectionRevision: overview.selectionRevision,
      planToken: overview.planToken,
      baselineOperationIds: [
        overview.activeOperation?.operationId,
        overview.lastOperation?.operationId,
      ].filter((operationId): operationId is string => operationId !== undefined),
    });
  }

  const sources = overview?.sources ?? [];
  const hasRows = (overview?.rows.length ?? 0) > 0;
  const allDisabled =
    overview !== undefined && sources.length > 0 && !sources.some((source) => source.active);

  return (
    <div className="kit-page" data-testid="kit-deploy-page">
      <header className="kit-header">
        <div className="kit-header-version">
          <div className="kit-title-block">
            <h1>Capabilities</h1>
            <span className="kit-title-meta">
              {selectedRows.length} selected
              {selectedTargets.length > 0
                ? ` for ${selectedTargets.map((target) => TARGET_LABEL[target]).join(", ")}`
                : ""}
            </span>
            {connection && (
              <span
                className={`kit-connection kit-connection-${connection.status}`}
                data-testid="kit-connection"
              >
                {connection.displayName} · {connection.status}
              </span>
            )}
          </div>
          <div className="kit-source-panel">
            <div className="kit-source-panel-head">
              <span className="kit-source-panel-title">Sources</span>
              <span className="kit-source-panel-meta">Precedence order, highest first</span>
            </div>
            <div className="kit-sources" data-testid="kit-sources">
              <SourceRows
                sources={sources}
                mirrors={overview?.mirrors ?? []}
                disabled={authorityUnknown}
                onToggle={(source) => toggleSource.mutate(source)}
                pendingId={toggleSource.isPending ? toggleSource.variables?.id : undefined}
                onDelete={(source) => deleteSource.mutate(source)}
                deletePendingId={deleteSource.isPending ? deleteSource.variables?.id : undefined}
                deleteFailedId={deleteSource.isError ? deleteSource.variables?.id : undefined}
                onReorder={(source, direction) => reorderSource.mutate({ source, direction })}
                reorderPendingId={
                  reorderSource.isPending ? reorderSource.variables?.source.id : undefined
                }
              />
            </div>
            <div className="kit-add-source-panel">
              <AddSourceForm
                apiConfig={apiConfig}
                inputRef={addSourceInputRef}
                onChanged={refetchOverview}
                disabled={authorityUnknown}
              />
            </div>
          </div>
        </div>
        <div className="kit-header-actions">
          <button
            type="button"
            className="button ghost"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || authorityUnknown}
            data-testid="kit-check-updates"
          >
            {syncMutation.isPending ? "Checking…" : "Check for updates"}
          </button>
          <button
            type="button"
            className="button ghost kit-header-deploy"
            onClick={deploy}
            disabled={!deployEnabled}
            data-testid="kit-deploy"
          >
            {deployLabel}
          </button>
          {deployArmed && removedCount > 0 && (
            <button
              type="button"
              className="button danger"
              onClick={deploy}
              disabled={!deployEnabled}
              data-testid="kit-deploy-confirm"
            >
              Confirm: delete {removedCount} &amp; deploy
            </button>
          )}
        </div>
      </header>

      {realHomeArmed && (
        <div className="banner-warn" data-testid="deploy-real-home-armed" role="alert">
          Deploys now write your real <code>~/.claude</code>, <code>~/.codex</code>, and{" "}
          <code>~/.agents</code> — no sandbox. Turn this off in Settings → Developer.
        </div>
      )}
      {removedCount > 0 && (
        <div className="banner-warn kit-deploy-remove-warn" data-testid="kit-deploy-remove-warn">
          Deploy will DELETE {removedCount} installed{" "}
          {removedCount === 1 ? "capability" : "capabilities"}. Review and confirm before deploying.
        </div>
      )}
      {manualInstallRows.length > 0 && (
        <div className="banner-warn" data-testid="kit-manual-install">
          Manual install required for {manualInstallRows.map((row) => row.key.name).join(", ")}.
          Hive does not run plugin or bundle installers from a durable Deploy.
        </div>
      )}
      {manualRemovalRows.length > 0 && (
        <div className="banner-error" data-testid="kit-manual-removal">
          Manual removal required for {manualRemovalRows.map((row) => row.key.name).join(", ")}.
          Deploy does not uninstall plugins or bundles.
        </div>
      )}
      {blockedInstructionRows.length > 0 && (
        <div className="banner-warn" data-testid="kit-instruction-blocked">
          Selected instructions are unavailable. Whole-file instruction reconciliation is blocked.
        </div>
      )}
      {unmanagedInstructionRows.length > 0 && (
        <div className="banner-warn" data-testid="kit-instruction-unmanaged">
          Whole-file instruction reconciliation is paused because the Deployment Ledger contains
          instruction contributions Hive does not manage:{" "}
          {unmanagedInstructionRows.map((row) => row.key.name).join(", ")}. Other capability changes
          can still Deploy.
        </div>
      )}
      {overview?.activeOperation && <OperationStatus operation={overview.activeOperation} />}
      {!overview?.activeOperation && overview?.lastOperation && (
        <OperationStatus operation={overview.lastOperation} />
      )}
      {(staleSelectionRevision !== null ||
        (selectionMutation.isError && !selectionConflictResolved)) && (
        <div className="banner-error" data-testid="kit-selection-error">
          {staleSelectionRevision !== null
            ? "Selection changed on the Daemon. Waiting for a newer Overview before changing it again."
            : selectionMutation.error instanceof SelectionConflictError
              ? "Selection changed on the Daemon. Reload the Overview before changing it again."
              : `Could not update Selection: ${selectionMutation.error?.message ?? "Unknown error"}`}
        </div>
      )}
      {(stalePlanToken !== null ||
        ambiguousDeploy !== null ||
        (deployMutation.isError && !planStaleResolved && !transportAcceptanceProven)) && (
        <div className="banner-error" data-testid="kit-deploy-error">
          {stalePlanToken !== null
            ? "The deployment plan changed. Waiting for a newer Overview before deploying again."
            : ambiguousDeploy !== null
              ? "Deploy acceptance is unknown. Waiting for Overview verification before retrying."
              : deployMutation.error instanceof PlanStaleError
                ? "The deployment plan changed. Reload the Overview before deploying again."
                : `Deploy could not be accepted: ${deployMutation.error?.message ?? "Unknown error"}`}
        </div>
      )}
      {toggleSource.isError && (
        <div className="banner-error" data-testid="kit-source-toggle-error">
          Could not change the Source — {toggleSource.error.message}
        </div>
      )}
      {deleteSource.isError && (
        <div className="banner-error" data-testid="kit-source-delete-error">
          Could not remove the Source — {deleteSource.error.message}
        </div>
      )}

      {overview && overview.diff.entries.length > 0 && <DeployDiffPanel overview={overview} />}

      <div className="kit-catalog" data-testid="kit-catalog">
        {overviewQuery.isLoading && <CatalogSkeleton />}
        {overviewQuery.isError && (
          <div className="kit-catalog-state kit-catalog-error" data-testid="kit-catalog-error">
            <p className="kit-catalog-state-title">Couldn&apos;t load the Deployment Overview.</p>
            <p className="kit-catalog-state-body">Check the Hive Daemon connection, then retry.</p>
            <button
              type="button"
              className="button primary"
              onClick={() => void overviewQuery.refetch()}
              disabled={overviewQuery.isFetching}
              data-testid="kit-catalog-retry"
            >
              {overviewQuery.isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {overview &&
          !hasRows &&
          (allDisabled ? (
            <div className="empty" data-testid="kit-empty-disabled">
              All Sources are disabled — enable one above to see its capabilities.
            </div>
          ) : (
            <div className="kit-catalog-state kit-empty-state" data-testid="kit-empty">
              <p className="kit-catalog-state-title">No capabilities yet.</p>
              <p className="kit-catalog-state-body">
                Hive deploys capabilities from one or more Sources into your Claude and Codex homes.
              </p>
              <button
                type="button"
                className="button primary"
                onClick={() => addSourceInputRef.current?.focus()}
                disabled={authorityUnknown}
                data-testid="kit-empty-add-source"
              >
                Add a Source
              </button>
            </div>
          ))}
        {overview &&
          KINDS.map((kind) => {
            const rows = overview.rows.filter((row) => row.key.kind === kind);
            if (rows.length === 0) return null;
            return (
              <KindSection
                key={kind}
                kind={kind}
                rows={rows}
                sourceLabels={new Map(overview.sources.map((source) => [source.id, source.label]))}
                pendingKey={
                  selectionMutation.isPending ? selectionMutation.variables?.row.key : undefined
                }
                selectionDisabled={authorityUnknown}
                onToggle={(row) =>
                  selectionMutation.mutate({
                    row,
                    expectedRevision: overview.selectionRevision,
                  })
                }
              />
            );
          })}
      </div>

      {overview && hasRows && (
        <DeploySummaryBar
          overview={overview}
          deployEnabled={deployEnabled}
          deployLabel={deployLabel}
          deployArmed={deployArmed}
          removedCount={removedCount}
          onDeploy={deploy}
        />
      )}
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function OperationStatus({
  operation,
}: {
  operation: NonNullable<DeploymentOverview["activeOperation"]>;
}): JSX.Element {
  const danger = operation.state === "failed" || operation.state === "interrupted";
  return (
    <div
      className={danger ? "banner-error" : "banner-info"}
      data-testid="kit-operation-status"
      role="status"
    >
      Deploy {operation.state} · {operation.operationId}
    </div>
  );
}

function AddSourceForm({
  apiConfig,
  inputRef,
  onChanged,
  disabled,
}: {
  apiConfig: ApiConfig;
  inputRef: RefObject<HTMLInputElement>;
  onChanged: () => void;
  disabled: boolean;
}): JSX.Element {
  const [empty, setEmpty] = useState(true);
  const addSource = useMutation<AddSourceResult, AddSourceError, string>({
    mutationFn: (origin) => api.addSource(apiConfig, origin),
    onSuccess: onChanged,
    onError: (error) => {
      if (error.cause.kind === "malformed-success") onChanged();
    },
  });
  return (
    <>
      <form
        className="add-source-form"
        data-testid="add-source-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
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
          disabled={addSource.isPending || disabled}
          onInput={(event) => {
            setEmpty(event.currentTarget.value.trim().length === 0);
            if (!addSource.isPending && (addSource.isError || addSource.data)) addSource.reset();
          }}
          aria-label="Git URL of a Source to add"
          data-testid="add-source-input"
        />
        <button
          type="submit"
          className="button"
          disabled={addSource.isPending || empty || disabled}
          data-testid="add-source-submit"
        >
          {addSource.isPending ? "Adding…" : "Add Source"}
        </button>
      </form>
      <AddSourceStatus state={addSource} />
    </>
  );
}

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

function SourceRows({
  sources,
  mirrors,
  disabled,
  onToggle,
  pendingId,
  onDelete,
  deletePendingId,
  deleteFailedId,
  onReorder,
  reorderPendingId,
}: {
  sources: OverviewSource[];
  mirrors: OverviewMirror[];
  disabled: boolean;
  onToggle: (source: OverviewSource) => void;
  pendingId: string | undefined;
  onDelete: (source: OverviewSource) => void;
  deletePendingId: string | undefined;
  deleteFailedId: string | undefined;
  onReorder: (source: OverviewSource, direction: "up" | "down") => void;
  reorderPendingId: string | undefined;
}): JSX.Element {
  const mirrorBySource = new Map(mirrors.map((mirror) => [mirror.sourceId, mirror]));
  return (
    <>
      {sources.map((source, index) => (
        <SourceRow
          key={source.id}
          source={source}
          mirror={mirrorBySource.get(source.id)}
          disabled={disabled}
          onToggle={() => onToggle(source)}
          togglePending={pendingId === source.id}
          onDelete={() => onDelete(source)}
          deletePending={deletePendingId === source.id}
          deleteFailed={deleteFailedId === source.id}
          onReorder={(direction) => onReorder(source, direction)}
          reorderPending={reorderPendingId === source.id}
          isFirst={index === 0}
          isLast={index === sources.length - 1}
        />
      ))}
    </>
  );
}

function SourceRow({
  source,
  mirror,
  disabled,
  onToggle,
  togglePending,
  onDelete,
  deletePending,
  deleteFailed,
  onReorder,
  reorderPending,
  isFirst,
  isLast,
}: {
  source: OverviewSource;
  mirror: OverviewMirror | undefined;
  disabled: boolean;
  onToggle: () => void;
  togglePending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  deleteFailed: boolean;
  onReorder: (direction: "up" | "down") => void;
  reorderPending: boolean;
  isFirst: boolean;
  isLast: boolean;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (deleteFailed) setConfirming(false);
  }, [deleteFailed]);
  return (
    <div
      className={`kit-source-row ${source.active ? "" : "kit-source-row-inactive"}`}
      data-testid={`kit-source-${source.id}`}
    >
      <span className="kit-source-origin" title={source.label}>
        {source.label}
      </span>
      {source.active && mirror && (
        <span className="kit-source-facts">
          <span
            className={`kit-fresh ${mirror.error ? "kit-fresh-error" : "kit-fresh-ok"}`}
            data-testid={`kit-freshness-${source.id}`}
          >
            {mirror.error ? "Unavailable" : "Ready"}
          </span>
          <span
            className={`kit-sha ${mirror.identity ? "" : "kit-sha-empty"}`}
            data-testid={`kit-sha-${source.id}`}
            title={mirror.identity ?? ""}
          >
            {shortIdentity(mirror.identity)}
          </span>
        </span>
      )}
      <label
        className={`kit-source-toggle ${source.active ? "on" : "off"}`}
        title={source.active ? "Deactivate" : "Activate"}
      >
        <input
          type="checkbox"
          className="kit-source-switch"
          checked={source.active}
          onChange={onToggle}
          disabled={togglePending || disabled}
          data-testid={`kit-source-toggle-${source.id}`}
          aria-label={`${source.active ? "Deactivate" : "Activate"} ${source.label}`}
        />
        <span className="kit-source-toggle-label" aria-hidden="true">
          {source.active ? "On" : "Off"}
        </span>
      </label>
      <span className="kit-source-rank" data-testid={`kit-source-rank-${source.id}`}>
        <button
          type="button"
          className="kit-source-up"
          onClick={() => onReorder("up")}
          disabled={reorderPending || isFirst || disabled}
          aria-label={`Raise precedence of ${source.label}`}
          data-testid={`kit-source-up-${source.id}`}
        >
          ▲
        </button>
        <button
          type="button"
          className="kit-source-down"
          onClick={() => onReorder("down")}
          disabled={reorderPending || isLast || disabled}
          aria-label={`Lower precedence of ${source.label}`}
          data-testid={`kit-source-down-${source.id}`}
        >
          ▼
        </button>
      </span>
      {confirming ? (
        <span
          className="kit-source-delete-confirm"
          data-testid={`kit-source-delete-arm-${source.id}`}
        >
          <span className="kit-source-delete-prompt">Remove?</span>
          <button
            type="button"
            className="kit-source-delete-go"
            onClick={onDelete}
            disabled={deletePending || disabled}
            data-testid={`kit-source-delete-confirm-${source.id}`}
          >
            {deletePending ? "Removing…" : "Remove"}
          </button>
          <button
            type="button"
            className="kit-source-delete-cancel"
            onClick={() => setConfirming(false)}
            data-testid={`kit-source-delete-cancel-${source.id}`}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="kit-source-delete"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          aria-label={`Remove ${source.label}`}
          data-testid={`kit-source-delete-${source.id}`}
        >
          Remove
        </button>
      )}
    </div>
  );
}

function CatalogSkeleton(): JSX.Element {
  return (
    <SkeletonGroup
      label="Loading Deployment Overview…"
      testId="kit-catalog-skeleton"
      className="kit-catalog-skeleton"
    >
      {["a", "b"].map((section) => (
        <div className="skeleton-kind" key={section}>
          <Skeleton width="40%" height="18px" />
          {["1", "2", "3"].map((row) => (
            <div className="skeleton-row" key={row}>
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
  rows,
  sourceLabels,
  pendingKey,
  selectionDisabled,
  onToggle,
}: {
  kind: CapabilityKind;
  rows: OverviewRow[];
  sourceLabels: Map<string, string>;
  pendingKey: OverviewRow["key"] | undefined;
  selectionDisabled: boolean;
  onToggle: (row: OverviewRow) => void;
}): JSX.Element {
  type Displayed = { row: OverviewRow; variant: OverviewRow["variants"][number] | undefined };
  const displayed: Displayed[] = [];
  for (const row of rows) {
    if (row.variants.length === 0) displayed.push({ row, variant: undefined });
    else for (const variant of row.variants) displayed.push({ row, variant });
  }
  const counts = new Map<string, number>();
  for (const item of displayed)
    counts.set(item.row.key.name, (counts.get(item.row.key.name) ?? 0) + 1);
  return (
    <section className="kit-kind" data-testid={`kit-kind-${kind}`}>
      <h2 className="kit-kind-title">
        <span>{KIND_LABEL[kind]}</span>
        <span className="kit-kind-count">{displayed.length}</span>
      </h2>
      <div className="kit-group">
        {displayed.map(({ row, variant }) => {
          const catalog = variant?.catalog ?? row.catalog;
          const shadowed = catalog === "shadowed";
          const blocked = catalog === "blocked";
          const selectable = !shadowed && !blocked;
          const multi = (counts.get(row.key.name) ?? 0) > 1;
          const suffix = variant?.contentSha.slice(0, 8);
          const testId =
            multi && suffix
              ? `kit-row-${kind}-${row.key.name}-${suffix}`
              : `kit-row-${kind}-${row.key.name}`;
          const selected = row.desired === "on" && !shadowed;
          const isPending =
            pendingKey !== undefined &&
            pendingKey.kind === row.key.kind &&
            pendingKey.name === row.key.name;
          return (
            <button
              type="button"
              role="switch"
              aria-checked={selected}
              aria-label={`${row.key.name} desired ${row.desired}`}
              key={`${row.key.kind}:${row.key.name}:${variant?.contentSha ?? "unavailable"}`}
              className={`kit-row ${selected ? "selected" : ""} ${blocked ? "blocked" : ""} ${shadowed ? "shadowed" : ""}`}
              onClick={() => selectable && onToggle(row)}
              disabled={!selectable || isPending || selectionDisabled}
              data-testid={testId}
            >
              <span className={`kit-row-check ${selected ? "checked" : ""}`} aria-hidden="true" />
              <span className="kit-row-main">
                <span className="kit-row-name">{row.key.name}</span>
                {variant?.description && (
                  <span className="kit-row-desc">{variant.description}</span>
                )}
                {variant && variant.sourceIds.length > 0 && (
                  <span className="kit-row-sources" data-testid={`kit-row-sources-${row.key.name}`}>
                    {variant.sourceIds.map((sourceId) => (
                      <span className="kit-source-label" key={sourceId}>
                        {sourceLabels.get(sourceId) ?? sourceId}
                      </span>
                    ))}
                  </span>
                )}
                {shadowed && (
                  <span
                    className="kit-row-shadow"
                    data-testid={`kit-row-shadow-${row.key.name}-${suffix ?? "unknown"}`}
                  >
                    Hidden by Source precedence
                    {variant?.shadowedBy
                      ? `: ${sourceLabels.get(variant.shadowedBy) ?? variant.shadowedBy} has higher Source precedence.`
                      : "."}
                  </span>
                )}
                {blocked && (
                  <span className="kit-row-blocked">
                    {variant?.blockedReason ?? "un-deployable"}
                  </span>
                )}
                <StateRail row={row} catalog={catalog} />
              </span>
              {shadowed && (
                <span className="kit-indicator kit-indicator-duplicate" data-status="duplicate">
                  not deployed (duplicate)
                </span>
              )}
              {blocked && (
                <span className="kit-indicator kit-indicator-blocked" data-status="blocked">
                  blocked
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function StateRail({ row, catalog }: { row: OverviewRow; catalog: string }): JSX.Element {
  const attempt = attemptLabel(row.lastAttempt);
  return (
    <span className="kit-state-rail" data-testid={`kit-state-${row.key.kind}-${row.key.name}`}>
      <span className="kit-state-fact">
        <span>Catalog</span>
        <strong>{catalogLabel(catalog)}</strong>
      </span>
      <span className="kit-state-arrow" aria-hidden="true">
        →
      </span>
      <span className="kit-state-fact">
        <span>Desired</span>
        <strong>{row.desired === "on" ? "On" : "Off"}</strong>
      </span>
      <span className="kit-state-arrow" aria-hidden="true">
        →
      </span>
      <span className="kit-state-fact">
        <span>Reconciliation</span>
        <strong>{RECONCILIATION_LABEL[row.reconciliation]}</strong>
      </span>
      {row.targets.map((target) => (
        <span className="kit-state-target" key={target.target}>
          <span>{TARGET_LABEL[target.target]}</span>
          <strong>{OBSERVATION_LABEL[target.observation]}</strong>
        </span>
      ))}
      <span className={`kit-state-attempt ${row.lastAttempt.state === "failed" ? "failed" : ""}`}>
        <span>Last attempt</span>
        <strong>{attempt}</strong>
      </span>
    </span>
  );
}

function catalogLabel(catalog: string): string {
  switch (catalog) {
    case "deployable":
      return "Available";
    case "shadowed":
      return "Shadowed";
    case "blocked":
      return "Blocked";
    default:
      return "Unavailable";
  }
}

function attemptLabel(attempt: OverviewLastAttempt): string {
  if (attempt.state === "none") return "None";
  if (attempt.state === "succeeded") return "Succeeded";
  return `Failed · ${attempt.code}`;
}

function DeploySummaryBar({
  overview,
  deployEnabled,
  deployLabel,
  deployArmed,
  removedCount,
  onDeploy,
}: {
  overview: DeploymentOverview;
  deployEnabled: boolean;
  deployLabel: string;
  deployArmed: boolean;
  removedCount: number;
  onDeploy: () => void;
}): JSX.Element {
  const selected = overview.rows.filter((row) => row.desired === "on");
  const targets = [
    ...new Set(
      selected.flatMap((row) =>
        row.targets.filter((target) => target.desired === "on").map((target) => target.target),
      ),
    ),
  ];
  const counts = diffCounts(overview);
  return (
    <div className="kit-sticky-deploy" data-testid="kit-sticky-deploy">
      <div className="kit-sticky-main">
        <span className="kit-sticky-count" data-testid="kit-sticky-selected">
          {selected.length} selected
        </span>
        <span className="kit-sticky-targets" data-testid="kit-sticky-targets">
          {targets.map((target) => TARGET_LABEL[target]).join(", ") || "No targets"}
        </span>
        <span className="kit-sticky-diff" data-testid="kit-sticky-diff">
          Added {counts.added} / Changed {counts.changed} / Removed {counts.removed}
        </span>
      </div>
      <div className="kit-sticky-actions">
        <button
          type="button"
          className="button primary"
          onClick={onDeploy}
          disabled={!deployEnabled}
          data-testid="kit-sticky-deploy-action"
        >
          {deployLabel}
        </button>
        {deployArmed && removedCount > 0 && (
          <button
            type="button"
            className="button danger"
            onClick={onDeploy}
            disabled={!deployEnabled}
            data-testid="kit-sticky-deploy-confirm"
          >
            Confirm: delete {removedCount} &amp; deploy
          </button>
        )}
      </div>
    </div>
  );
}

function diffCounts(overview: DeploymentOverview): Record<DiffChange, number> {
  const counts: Record<DiffChange, number> = { added: 0, changed: 0, removed: 0 };
  for (const entry of overview.diff.entries) counts[entry.change]++;
  return counts;
}

function DeployDiffPanel({ overview }: { overview: DeploymentOverview }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const counts = diffCounts(overview);
  const hasUserFileWarning = overview.diff.entries.some((entry) => entry.replacesUserFile);
  const sourceLabels = new Map(overview.sources.map((source) => [source.id, source.label]));
  const rowsForEntry = (kind: CapabilityKind, name: string): OverviewRow[] =>
    kind === "instruction" && name.startsWith("(")
      ? overview.rows.filter((row) => row.key.kind === "instruction" && row.desired === "on")
      : overview.rows.filter((row) => row.key.kind === kind && row.key.name === name);
  return (
    <section className="kit-diff" data-testid="kit-diff">
      <button
        type="button"
        className="kit-diff-head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        data-testid="kit-diff-toggle"
      >
        <span className="kit-diff-summary" data-testid="kit-diff-summary">
          {DIFF_BUCKETS.map((bucket) => (
            <span className={`kit-diff-count kit-diff-count-${bucket.change}`} key={bucket.change}>
              {bucket.glyph}
              {counts[bucket.change]} {bucket.label}
            </span>
          ))}
        </span>
      </button>
      {hasUserFileWarning && (
        <div className="banner-warn" data-testid="kit-diff-userfile-warn">
          This Deploy replaces an existing global instruction file such as CLAUDE.md.
        </div>
      )}
      {expanded && (
        <div className="kit-diff-review" data-testid="kit-diff-review">
          {DIFF_BUCKETS.map((bucket) => {
            const entries = overview.diff.entries.filter((entry) => entry.change === bucket.change);
            if (entries.length === 0) return null;
            return (
              <div
                className={`kit-diff-column ${bucket.change === "removed" ? "kit-diff-removed" : ""}`}
                key={bucket.change}
                data-testid={`kit-diff-${bucket.change}`}
              >
                <h3>
                  {bucket.label} {entries.length}
                </h3>
                <ul>
                  {entries.map((entry) => {
                    const rows = rowsForEntry(entry.kind, entry.name);
                    const winners = rows.flatMap((row) =>
                      row.variants.filter((variant) => variant.catalog === "deployable"),
                    );
                    const hidden = rows.flatMap((row) =>
                      row.variants.filter((variant) => variant.catalog === "shadowed"),
                    );
                    const winnerLabels = [
                      ...new Set(
                        winners
                          .flatMap((variant) => variant.sourceIds)
                          .map((sourceId) => sourceLabels.get(sourceId) ?? sourceId),
                      ),
                    ];
                    return (
                      <li key={`${entry.kind}:${entry.name}`}>
                        <span>{entry.name}</span>
                        <span>{entry.kind}</span>
                        {winnerLabels.length > 0 && (
                          <span data-testid={`kit-diff-sources-${entry.name}`}>
                            {winnerLabels.join(", ")}
                          </span>
                        )}
                        {hidden.length > 0 && (
                          <span data-testid={`kit-diff-hidden-${entry.name}`}>
                            Hidden duplicate from{" "}
                            {hidden
                              .flatMap((variant) => variant.sourceIds)
                              .map((sourceId) => sourceLabels.get(sourceId) ?? sourceId)
                              .join(", ")}
                            ; {winnerLabels.join(", ")} wins by Source precedence.
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
