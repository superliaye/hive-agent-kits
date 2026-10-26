import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  type ApiConfig,
  api,
  type CapabilityKind,
  type DeploymentOverview,
  type DeployTarget,
  type OverviewLastAttempt,
  type OverviewRow,
  type OverviewSource,
  PlanStaleError,
  type PresetSummary,
  type ReconciliationState,
  SelectionConflictError,
  type SelectionMutation,
  SelectionUnitConflictError,
  type SyncRunResult,
  type TargetObservation,
} from "../api.ts";
import { Skeleton, SkeletonGroup } from "../components/Skeleton.tsx";
import { TileShelf, useTiles } from "../components/TileShelf.tsx";
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
const KIND_TO_PRESET_CAPABILITIES = {
  instruction: "instructions",
  skill: "skills",
  agent: "agents",
  plugin: "plugins",
  bundle: "bundles",
} as const satisfies Record<CapabilityKind, keyof PresetSummary["capabilities"]>;
const TARGET_LABEL: Record<DeployTarget, string> = { claude: "Claude", codex: "Codex" };
const DEPLOY_TARGETS: DeployTarget[] = ["claude", "codex"];
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
type SelectionAttempt = {
  expectedRevision: number;
  changes: SelectionMutation["changes"];
};
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

function keyId(key: OverviewRow["key"]): string {
  return `${key.kind}:${key.name}`;
}

function desiredTargets(row: OverviewRow): DeployTarget[] {
  return row.targets.filter((target) => target.desired === "on").map((target) => target.target);
}

// Selection changes that turn off, where they are on, the Capabilities that
// lose their only Source when `sourceId` goes.
function turnOffWith(overview: DeploymentOverview, sourceId: string): SelectionMutation["changes"] {
  return overview.rows.flatMap((row) => {
    const targets = desiredTargets(row);
    const provides = row.variants.some((variant) => variant.sourceIds.includes(sourceId));
    const othersProvide = row.variants.some(
      (variant) => variant.catalog !== "blocked" && variant.sourceIds.some((id) => id !== sourceId),
    );
    return targets.length > 0 && provides && !othersProvide
      ? [{ key: row.key, enabled: false, targets }]
      : [];
  });
}

function presetKeys(preset: PresetSummary): OverviewRow["key"][] {
  return KINDS.flatMap((kind) =>
    preset.capabilities[KIND_TO_PRESET_CAPABILITIES[kind]].map((name) => ({ kind, name })),
  );
}

function presetActive(preset: PresetSummary, rowsByKey: Map<string, OverviewRow>): boolean {
  const keys = presetKeys(preset);
  return keys.length > 0 && keys.every((key) => rowsByKey.get(keyId(key))?.desired === "on");
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

function unitConflictMessage(error: SelectionUnitConflictError, sources: OverviewSource[]): string {
  const label = sources.find((source) => source.id === error.sourceId)?.label ?? error.sourceId;
  return `${label} installs whole, so its Capabilities turn on and off together. This change turned some on and some off for ${TARGET_LABEL[error.target]}, so Hive did not apply it.`;
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
  const [targetPreference, setTargetPreference] = useState<DeployTarget[]>(["claude"]);
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
  const catalogQuery = useQuery({
    queryKey: ["kit", "catalog"],
    queryFn: () => api.getKitCatalog(apiConfig),
  });
  const presets = catalogQuery.data?.presets ?? [];
  const tilesQuery = useTiles(apiConfig);
  const tileDescriptions = new Map(
    (tilesQuery.data ?? []).flatMap((tile) =>
      tile.sourceId === null ? [] : [[tile.sourceId, tile.description] as const],
    ),
  );
  const selectedRows = overview?.rows.filter((row) => row.desired === "on") ?? [];
  const selectedTargets = [...new Set(selectedRows.flatMap((row) => desiredTargets(row)))];
  const activeTargets = selectedTargets.length > 0 ? selectedTargets : targetPreference;
  const rowsByKey = new Map((overview?.rows ?? []).map((row) => [keyId(row.key), row]));
  const activePresets = presets.filter((preset) => presetActive(preset, rowsByKey));
  const activePresetKeys = new Set(
    activePresets.flatMap((preset) => presetKeys(preset).map(keyId)),
  );
  const manualSelectionCount = selectedRows.filter(
    (row) => !activePresetKeys.has(keyId(row.key)),
  ).length;

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

  const refetchKit = (): void => {
    refetchOverview();
    void queryClient.invalidateQueries({ queryKey: ["kit", "catalog"] });
    void queryClient.invalidateQueries({ queryKey: ["tiles"] });
  };

  const syncMutation = useMutation({
    mutationFn: () => api.syncKit(apiConfig),
    onSuccess: (result: SyncRunResult) => {
      const toast = syncToast(result);
      pushToast(toast.kind, toast.message);
    },
    onError: () => pushToast("error", "Sync failed"),
    onSettled: refetchKit,
  });

  // Removing a Source first turns off the selected Capabilities only it
  // provides, so the next Deploy uninstalls them instead of leaving them behind.
  const removeSource = useMutation({
    mutationFn: async (source: OverviewSource) => {
      const current = overviewQuery.data;
      const changes = current ? turnOffWith(current, source.id) : [];
      if (current && changes.length > 0) {
        await api.patchKitSelection(apiConfig, {
          expectedRevision: current.selectionRevision,
          changes,
        });
      }
      await api.deleteSource(apiConfig, source.id);
    },
    onSuccess: (_result, source) => {
      pushToast("success", `Removed ${source.label}`);
    },
    onError: () => pushToast("error", "Could not remove the Source"),
    onSettled: refetchKit,
  });

  const selectionMutation = useMutation({
    mutationFn: ({ changes, expectedRevision }: SelectionAttempt) => {
      return api.patchKitSelection(apiConfig, {
        expectedRevision,
        changes,
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
  const manualInstallRows =
    overview?.rows.filter((row) => row.reconciliation === "manual_install_required") ?? [];
  const manualRemovalRows =
    overview?.rows.filter((row) => row.reconciliation === "manual_removal_required") ?? [];
  const blockedInstructionRows =
    overview?.rows.filter(
      (row) =>
        row.key.kind === "instruction" && row.desired === "on" && row.catalog === "unavailable",
    ) ?? [];

  // The daemon applies a change to one row of a whole unit to every row of it, on
  // the CLIs the change names, so a unit row names the CLIs of the whole unit.
  function unitRows(row: OverviewRow): OverviewRow[] {
    const unit = row.wholeSourceId;
    if (unit === null || !overview) return [row];
    return overview.rows.filter((candidate) => candidate.wholeSourceId === unit);
  }

  function targetsForRow(row: OverviewRow): DeployTarget[] {
    const applicable = DEPLOY_TARGETS.filter((target) =>
      unitRows(row).some((member) => member.applicableTargets.includes(target)),
    );
    const matching = applicable.filter((target) => activeTargets.includes(target));
    return matching.length > 0 ? matching : applicable;
  }

  function enabledTargetsForRow(row: OverviewRow): DeployTarget[] {
    return DEPLOY_TARGETS.filter((target) =>
      unitRows(row).some((member) => desiredTargets(member).includes(target)),
    );
  }

  function toggleRow(row: OverviewRow): void {
    if (!overview) return;
    selectionMutation.mutate({
      expectedRevision: overview.selectionRevision,
      changes: [
        {
          key: row.key,
          enabled: row.desired === "off",
          targets: row.desired === "off" ? targetsForRow(row) : enabledTargetsForRow(row),
        },
      ],
    });
  }

  function toggleTarget(target: DeployTarget): void {
    if (!overview || authorityUnknown || selectionMutation.isPending) return;
    const nextTargets = activeTargets.includes(target)
      ? activeTargets.filter((candidate) => candidate !== target)
      : DEPLOY_TARGETS.filter(
          (candidate) => activeTargets.includes(candidate) || candidate === target,
        );
    if (nextTargets.length === 0) return;
    setTargetPreference(nextTargets);
    const enabled = nextTargets.includes(target);
    const changes = selectedRows.flatMap((row) => {
      if (!row.applicableTargets.includes(target)) return [];
      const currentlyEnabled = desiredTargets(row).includes(target);
      if (currentlyEnabled === enabled) return [];
      return [{ key: row.key, enabled, targets: [target] }];
    });
    if (changes.length === 0) return;
    selectionMutation.mutate({ expectedRevision: overview.selectionRevision, changes });
  }

  function togglePreset(preset: PresetSummary): void {
    if (!overview || authorityUnknown || selectionMutation.isPending) return;
    const active = presetActive(preset, rowsByKey);
    const keptByOtherPreset = new Set(
      activePresets
        .filter((candidate) => candidate.name !== preset.name)
        .flatMap((candidate) => presetKeys(candidate).map(keyId)),
    );
    const changes = presetKeys(preset).flatMap((key) => {
      const row = rowsByKey.get(keyId(key));
      if (!row) return [];
      if (active) {
        if (keptByOtherPreset.has(keyId(key))) return [];
        const targets = enabledTargetsForRow(row);
        return targets.length > 0 ? [{ key, enabled: false, targets }] : [];
      }
      return row.desired === "off" ? [{ key, enabled: true, targets: targetsForRow(row) }] : [];
    });
    if (changes.length === 0) return;
    selectionMutation.mutate({ expectedRevision: overview.selectionRevision, changes });
  }

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

  const pendingKeys = selectionMutation.isPending
    ? selectionMutation.variables?.changes.map((change) => change.key)
    : undefined;
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
      <TileShelf
        apiConfig={apiConfig}
        sources={sources}
        mirrors={overview?.mirrors ?? []}
        removal={{
          remove: (source) => removeSource.mutate(source),
          pendingId: removeSource.isPending ? removeSource.variables?.id : undefined,
          failedId: removeSource.isError ? removeSource.variables?.id : undefined,
          turnsOff: (sourceId) => (overview ? turnOffWith(overview, sourceId).length : 0),
        }}
        onSourceAdded={refetchKit}
        disabled={authorityUnknown}
      />

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
          Hive does not run installers that lack durable metadata.
        </div>
      )}
      {manualRemovalRows.length > 0 && (
        <div className="banner-error" data-testid="kit-manual-removal">
          Manual removal required for {manualRemovalRows.map((row) => row.key.name).join(", ")}.
          Deploy does not uninstall installers that lack durable metadata.
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
              : selectionMutation.error instanceof SelectionUnitConflictError
                ? unitConflictMessage(selectionMutation.error, sources)
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
      {removeSource.isError && (
        <div className="banner-error" data-testid="kit-source-delete-error">
          Could not remove the Source — {removeSource.error.message}
        </div>
      )}

      {overview && hasRows && (
        <div className="kit-controls">
          <div className="kit-presets" data-testid="kit-presets">
            <span className="kit-control-label">Preset</span>
            {catalogQuery.isLoading ? (
              <span className="kit-presets-none">loading…</span>
            ) : catalogQuery.isError ? (
              <span className="kit-presets-none">unavailable</span>
            ) : presets.length === 0 ? (
              <span className="kit-presets-none">none</span>
            ) : (
              presets.map((preset) => (
                <button
                  type="button"
                  key={preset.name}
                  className={`badge kit-preset ${presetActive(preset, rowsByKey) ? "active" : ""}`}
                  onClick={() => togglePreset(preset)}
                  title={preset.description}
                  disabled={authorityUnknown || selectionMutation.isPending}
                >
                  {preset.name}
                </button>
              ))
            )}
            {presets.length > 0 && (
              <span className="kit-preset-note" data-testid="kit-preset-note">
                Presets add to the current Selection; {manualSelectionCount} selected outside active
                Presets.
              </span>
            )}
          </div>
          <div className="kit-targets" data-testid="kit-targets">
            <span className="kit-control-label">Targets</span>
            {DEPLOY_TARGETS.map((target) => (
              <label key={target} className="kit-target-toggle">
                <input
                  type="checkbox"
                  className="kit-target-check"
                  checked={activeTargets.includes(target)}
                  onChange={() => toggleTarget(target)}
                  disabled={authorityUnknown || selectionMutation.isPending}
                  data-testid={`kit-target-${target}`}
                />
                {TARGET_LABEL[target]}
              </label>
            ))}
          </div>
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
              All Sources are off, so there are no capabilities to show.
            </div>
          ) : (
            <div className="kit-catalog-state kit-empty-state" data-testid="kit-empty">
              <p className="kit-catalog-state-title">No capabilities yet.</p>
              <p className="kit-catalog-state-body">
                Hive deploys capabilities from one or more Sources into your Claude and Codex homes.
                Add a Tile above, or add any Source by its link.
              </p>
            </div>
          ))}
        {overview && (
          <WholeSourceSection
            overview={overview}
            descriptions={tileDescriptions}
            pendingKeys={pendingKeys}
            selectionDisabled={authorityUnknown}
            onToggle={toggleRow}
          />
        )}
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
                pendingKeys={pendingKeys}
                selectionDisabled={authorityUnknown}
                onToggle={toggleRow}
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

// A Source that installs whole is one row: its Capabilities may differ in kind
// and CLI, but they turn on and off together.
function WholeSourceSection({
  overview,
  descriptions,
  pendingKeys,
  selectionDisabled,
  onToggle,
}: {
  overview: DeploymentOverview;
  descriptions: Map<string, string>;
  pendingKeys: OverviewRow["key"][] | undefined;
  selectionDisabled: boolean;
  onToggle: (row: OverviewRow) => void;
}): JSX.Element | null {
  const units = overview.sources.flatMap((source) => {
    const members = overview.rows.filter((row) => row.wholeSourceId === source.id);
    const toggled = members.find((row) => row.desired === "on") ?? members[0];
    return toggled ? [{ source, members, toggled }] : [];
  });
  if (units.length === 0) return null;
  return (
    <section className="kit-kind" data-testid="kit-kind-whole">
      <h2 className="kit-kind-title">
        <span>Whole Sources</span>
        <span className="kit-kind-count">{units.length}</span>
      </h2>
      <div className="kit-group">
        {units.map(({ source, members, toggled }) => {
          const selected = toggled.desired === "on";
          const isPending = members.some((row) =>
            pendingKeys?.some((key) => key.kind === row.key.kind && key.name === row.key.name),
          );
          const description = descriptions.get(source.id);
          return (
            <button
              type="button"
              role="switch"
              aria-checked={selected}
              aria-label={`${source.label} desired ${selected ? "on" : "off"}`}
              key={source.id}
              className={`kit-row ${selected ? "selected" : ""}`}
              onClick={() => onToggle(toggled)}
              disabled={isPending || selectionDisabled}
              data-testid={`kit-unit-${source.id}`}
            >
              <span className={`kit-row-check ${selected ? "checked" : ""}`} aria-hidden="true" />
              <span className="kit-row-main">
                <span className="kit-row-name">{source.label}</span>
                {description && <span className="kit-row-desc">{description}</span>}
                <span className="kit-unit-members">
                  {members.map((row) => (
                    <span
                      className="kit-unit-member"
                      key={keyId(row.key)}
                      data-testid={`kit-unit-member-${row.key.kind}-${row.key.name}`}
                    >
                      <span className="kit-unit-member-name">
                        {row.key.name}{" "}
                        <span className="kit-unit-member-meta">
                          {row.key.kind} ·{" "}
                          {row.applicableTargets.map((target) => TARGET_LABEL[target]).join(", ")}
                        </span>
                      </span>
                      <StateRail row={row} catalog={row.catalog} />
                    </span>
                  ))}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function KindSection({
  kind,
  rows,
  sourceLabels,
  pendingKeys,
  selectionDisabled,
  onToggle,
}: {
  kind: CapabilityKind;
  rows: OverviewRow[];
  sourceLabels: Map<string, string>;
  pendingKeys: OverviewRow["key"][] | undefined;
  selectionDisabled: boolean;
  onToggle: (row: OverviewRow) => void;
}): JSX.Element | null {
  type Displayed = { row: OverviewRow; variant: OverviewRow["variants"][number] | undefined };
  const displayed: Displayed[] = [];
  for (const row of rows) {
    if (row.variants.length === 0) displayed.push({ row, variant: undefined });
    else
      for (const variant of row.variants) {
        // The whole Source's row carries the winning copy; a lower-precedence copy stays here.
        if (row.wholeSourceId !== null && variant.catalog === "deployable") continue;
        displayed.push({ row, variant });
      }
  }
  if (displayed.length === 0) return null;
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
          const isPending = pendingKeys?.some(
            (key) => key.kind === row.key.kind && key.name === row.key.name,
          );
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
