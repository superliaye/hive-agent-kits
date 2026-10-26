// Selection units (ADR-0033). A Source whose Recipe installs it whole is one
// unit: a change to any of its Capabilities applies to all of them. A unit is
// the set of keys whose winning Variant lists the Source, so a Merge counts and
// a Shadowed copy does not. Units are derived on every use and never stored;
// Selection keeps storing CapabilityKeys and targets only.

import { type CapabilityKey, serializeCapabilityKey } from "@hive/capability-schema";
import type {
  Catalog,
  DeployTarget,
  OverviewSource,
  SelectionMutation,
  SelectionSnapshot,
} from "@hive/contract";

type Change = SelectionMutation["changes"][number];

// One mutation turned one unit both on and off for one target.
export class SelectionUnitConflictError extends Error {
  readonly sourceId: string;
  readonly target: DeployTarget;

  constructor(sourceId: string, target: DeployTarget) {
    super(`selection_unit_conflict: ${sourceId} on ${target}`);
    this.name = "SelectionUnitConflictError";
    this.sourceId = sourceId;
    this.target = target;
  }
}

type SelectionUnits = {
  // The changes to store: the closure of `current` first, so a deselect also
  // records removals for keys only the closure enabled, then each change on a
  // unit key applied to every key of its units. Throws
  // SelectionUnitConflictError.
  expand(current: SelectionSnapshot, changes: readonly Change[]): Change[];
  // For every Selection read: a unit with any key enabled on a target has every
  // key enabled there. This covers drift no mutation made, such as a re-Sync
  // that adds a Capability to a whole Source.
  close(selection: SelectionSnapshot): SelectionSnapshot;
  // The highest-precedence whole Source holding the key, or null.
  wholeSourceOf(key: CapabilityKey): string | null;
};

const TARGET_ORDER: readonly DeployTarget[] = ["claude", "codex"];

export function selectionUnits(
  catalog: Catalog,
  sources: readonly Pick<OverviewSource, "id" | "active" | "recipe">[],
): SelectionUnits {
  const whole = new Set(
    sources.filter((s) => s.active && s.recipe?.unit === "whole").map((s) => s.id),
  );
  const members = new Map<string, CapabilityKey[]>();
  const holders = new Map<string, string[]>();
  for (const entry of catalog.entries) {
    if (!entry.deployable) continue;
    const key: CapabilityKey = { kind: entry.kind, name: entry.name };
    const id = serializeCapabilityKey(key);
    // sourceIds is winner-first, so holders keep precedence order.
    for (const sourceId of entry.sourceIds) {
      if (!whole.has(sourceId)) continue;
      members.set(sourceId, [...(members.get(sourceId) ?? []), key]);
      holders.set(id, [...(holders.get(id) ?? []), sourceId]);
    }
  }

  const close = (selection: SelectionSnapshot): SelectionSnapshot => {
    if (members.size === 0) return selection;
    const enabled = new Map(
      selection.enabled.map(
        (entry) =>
          [
            serializeCapabilityKey(entry.key),
            { key: entry.key, targets: new Set(entry.targets) },
          ] as const,
      ),
    );
    // Overlapping units (a Merge across whole Sources) settle in a few passes.
    let grew = true;
    while (grew) {
      grew = false;
      for (const keys of members.values()) {
        const on = new Set(
          keys.flatMap((key) => [...(enabled.get(serializeCapabilityKey(key))?.targets ?? [])]),
        );
        if (on.size === 0) continue;
        for (const key of keys) {
          const id = serializeCapabilityKey(key);
          const entry = enabled.get(id) ?? { key, targets: new Set<DeployTarget>() };
          for (const target of on) {
            if (entry.targets.has(target)) continue;
            entry.targets.add(target);
            grew = true;
          }
          enabled.set(id, entry);
        }
      }
    }
    return {
      revision: selection.revision,
      enabled: [...enabled.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, entry]) => ({
          key: entry.key,
          targets: TARGET_ORDER.filter((target) => entry.targets.has(target)),
        })),
      // Enabling a pair clears its removal intent, as a stored enable does.
      removalIntents: selection.removalIntents.filter(
        (intent) =>
          !intent.targets.every((target) =>
            enabled.get(serializeCapabilityKey(intent.key))?.targets.has(target),
          ),
      ),
    };
  };

  const expand = (current: SelectionSnapshot, changes: readonly Change[]): Change[] => {
    const before = new Map(
      current.enabled.map((entry) => [serializeCapabilityKey(entry.key), entry.targets] as const),
    );
    const closure = close(current).enabled.flatMap((entry): Change[] => {
      const prior = before.get(serializeCapabilityKey(entry.key)) ?? [];
      const added = entry.targets.filter((target) => !prior.includes(target));
      return added.length > 0 ? [{ key: entry.key, enabled: true, targets: added }] : [];
    });
    const edits = new Map<string, boolean>();
    const expanded = changes.flatMap((change): Change[] => {
      const units = holders.get(serializeCapabilityKey(change.key)) ?? [];
      if (units.length === 0) return [change];
      for (const sourceId of units) {
        for (const target of change.targets) {
          const edit = `${sourceId}\u0000${target}`;
          const prior = edits.get(edit);
          if (prior !== undefined && prior !== change.enabled) {
            throw new SelectionUnitConflictError(sourceId, target);
          }
          edits.set(edit, change.enabled);
        }
      }
      const keys = new Map(
        units
          .flatMap((sourceId) => members.get(sourceId) ?? [])
          .map((key) => [serializeCapabilityKey(key), key] as const),
      );
      return [...keys.values()].map((key) => ({
        key,
        enabled: change.enabled,
        targets: change.targets,
      }));
    });
    return [...closure, ...expanded];
  };

  return {
    expand,
    close,
    wholeSourceOf: (key) => holders.get(serializeCapabilityKey(key))?.[0] ?? null,
  };
}
