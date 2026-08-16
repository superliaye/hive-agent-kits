import type {
  CapabilityEntry,
  CapabilityKind,
  Catalog,
  DeployDiff,
  DeploymentOverview,
  DeployTarget,
  KitState,
  OverviewRow,
  Source,
} from "../api.ts";

const TOKEN = "a".repeat(64);

function keyId(kind: CapabilityKind, name: string): string {
  return `${kind}:${name}`;
}

function applicableTargets(kind: CapabilityKind): DeployTarget[] {
  return kind === "plugin" || kind === "bundle" ? ["claude"] : ["claude", "codex"];
}

function ledgerKeys(state: KitState): Map<string, { kind: CapabilityKind; name: string }> {
  const keys = new Map<string, { kind: CapabilityKind; name: string }>();
  const ledger = state.ledger;
  if (!ledger) return keys;
  for (const entry of ledger.instructions)
    keys.set(keyId("instruction", entry.name), { kind: "instruction", name: entry.name });
  for (const entry of ledger.skills)
    keys.set(keyId("skill", entry.name), { kind: "skill", name: entry.name });
  for (const entry of ledger.agentDefs)
    keys.set(keyId("agent", entry.name), { kind: "agent", name: entry.name });
  for (const entry of ledger.plugins)
    keys.set(keyId("plugin", entry.name), { kind: "plugin", name: entry.name });
  for (const entry of ledger.bundles)
    keys.set(keyId("bundle", entry.name), { kind: "bundle", name: entry.name });
  return keys;
}

function variantsFor(entries: CapabilityEntry[]): OverviewRow["variants"] {
  return entries.map((entry) => ({
    ...entry,
    catalog: entry.deployable ? "deployable" : entry.shadowed ? "shadowed" : "blocked",
  }));
}

export function overviewFromLegacy(
  input: {
    catalog?: Catalog;
    state?: KitState;
    sources?: Source[];
    diff?: DeployDiff;
    desired?: Set<string>;
    selectionRevision?: number;
    planToken?: string;
  } = {},
): DeploymentOverview {
  const catalog = input.catalog ?? { entries: [], presets: [], problems: [] };
  const state = input.state ?? { sync: [], ledger: null };
  const sources = [...(input.sources ?? [])].sort((left, right) => right.rank - left.rank);
  const diff = input.diff ?? { entries: [] };
  const ledger = ledgerKeys(state);
  const desired = input.desired ?? new Set(ledger.keys());
  const keys = new Map(ledger);
  for (const entry of catalog.entries)
    keys.set(keyId(entry.kind, entry.name), { kind: entry.kind, name: entry.name });
  for (const id of desired) {
    const split = id.indexOf(":");
    if (split > 0)
      keys.set(id, { kind: id.slice(0, split) as CapabilityKind, name: id.slice(split + 1) });
  }
  const targets = state.ledger?.agents.filter(
    (target): target is DeployTarget => target === "claude" || target === "codex",
  ) ?? ["claude"];
  const rows = [...keys.entries()].map(([id, key]): OverviewRow => {
    const entries = catalog.entries.filter((entry) => keyId(entry.kind, entry.name) === id);
    const selected = desired.has(id);
    const change = diff.entries.find((entry) => keyId(entry.kind, entry.name) === id)?.change;
    const reconciliation =
      change === "added"
        ? ("pending_add" as const)
        : change === "changed"
          ? ("pending_update" as const)
          : change === "removed"
            ? ("pending_remove" as const)
            : selected && entries.length === 0
              ? ("waiting_for_source" as const)
              : ledger.has(id) && entries.length === 0
                ? ("unmanaged_owned" as const)
                : ("in_sync" as const);
    const applicable = applicableTargets(key.kind);
    return {
      key,
      catalog: entries.some((entry) => entry.deployable)
        ? "deployable"
        : entries.length === 0
          ? "unavailable"
          : entries.every((entry) => entry.shadowed)
            ? "shadowed"
            : "blocked",
      desired: selected ? "on" : "off",
      reconciliation,
      lastAttempt: { state: "none" },
      applicableTargets: applicable,
      targets: applicable.map((target) => ({
        target,
        desired: selected && targets.includes(target) ? "on" : "off",
        reconciliation,
        observation: ledger.has(id) ? "present_unverified" : "missing",
        lastAttempt: { state: "none" },
      })),
      variants: variantsFor(entries),
    };
  });
  return {
    sources: sources.map((source) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      active: source.active,
      rank: source.rank,
    })),
    sourceRegistryRevision: 1,
    mirrors: state.sync.map((sync, index) => ({
      sourceId: sync.sourceId,
      precedence: sources.find((source) => source.id === sync.sourceId)?.rank ?? index,
      identity: sync.sha,
      ...(sync.state === "check_failed" || sync.state === "rate_limited"
        ? { error: "unavailable" as const }
        : {}),
    })),
    selectionRevision: input.selectionRevision ?? 7,
    variants: catalog.entries,
    rows,
    diff,
    planToken: input.planToken ?? TOKEN,
    activeOperation: null,
    lastOperation: null,
  };
}
