// Durable Selection store. The Deployment Ledger can seed it once, but never
// becomes desired-state authority after initialization.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { CapabilityKey, serializeCapabilityKey } from "@hive/capability-schema";
import {
  DeployTarget,
  type Ledger,
  SelectionMutation,
  SelectionSnapshot,
  type SelectionSnapshot as SelectionSnapshotType,
} from "@hive/contract";
import { z } from "zod";

const SelectionEntry = z.object({ key: CapabilityKey, targets: z.array(DeployTarget).min(1) });

export const SelectionFile = z.object({
  schemaVersion: z.literal(1),
  initialized: z.literal(true),
  revision: z.number().int().nonnegative(),
  enabled: z.array(SelectionEntry),
  removalIntents: z.array(SelectionEntry),
});

const UninitializedSelectionFile = z
  .object({ schemaVersion: z.literal(1), initialized: z.literal(false) })
  .strict();

type SelectionEntry = z.infer<typeof SelectionEntry>;
type SelectionFile = z.infer<typeof SelectionFile>;

const targetOrder: Record<z.infer<typeof DeployTarget>, number> = { claude: 0, codex: 1 };

export class SelectionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`selection_conflict: current revision is ${currentRevision}`);
    this.name = "SelectionConflictError";
    this.currentRevision = currentRevision;
  }
}

export type SelectionStoreOptions = {
  rename?: (oldPath: string, newPath: string) => void;
  fsyncDirectory?: (directory: string) => void;
};

export type SelectionStore = {
  read(): SelectionSnapshotType;
  seedOnce(ledger: Ledger | null): SelectionSnapshotType;
  mutate(body: z.input<typeof SelectionMutation>, ledger?: Ledger | null): SelectionSnapshotType;
  // Internal seam for a later successful Deploy removal outcome. It changes only
  // matching intents and never lets Deployment State author Selection.
  clearRemovalIntents(
    expectedRevision: number,
    entries: readonly SelectionEntry[],
  ): SelectionSnapshotType;
};

function snapshot(file: SelectionFile): SelectionSnapshotType {
  return SelectionSnapshot.parse({
    revision: file.revision,
    enabled: file.enabled,
    removalIntents: file.removalIntents,
  });
}

function uniqueTargets(
  targets: readonly z.infer<typeof DeployTarget>[],
): z.infer<typeof DeployTarget>[] {
  return [...new Set(targets)].sort((a, b) => targetOrder[a] - targetOrder[b]);
}

function canonical(entries: Iterable<SelectionEntry>): SelectionEntry[] {
  return [...entries]
    .map((entry) => ({
      key: CapabilityKey.parse(entry.key),
      targets: uniqueTargets(entry.targets),
    }))
    .filter((entry) => entry.targets.length > 0)
    .sort((a, b) => serializeCapabilityKey(a.key).localeCompare(serializeCapabilityKey(b.key)));
}

function emptyFile(): SelectionFile {
  return { schemaVersion: 1, initialized: true, revision: 1, enabled: [], removalIntents: [] };
}

function targetsFromLedger(ledger: Ledger): z.infer<typeof DeployTarget>[] {
  return uniqueTargets(
    ledger.agents.filter(
      (target): target is z.infer<typeof DeployTarget> => DeployTarget.safeParse(target).success,
    ),
  );
}

function seedFile(ledger: Ledger | null): SelectionFile {
  if (!ledger) return emptyFile();
  const targets = targetsFromLedger(ledger);
  if (targets.length === 0) return emptyFile();
  const enabled: SelectionEntry[] = [
    ...ledger.instructions.map((entry) => ({
      key: { kind: "instruction" as const, name: entry.name },
      targets,
    })),
    ...ledger.skills.map((entry) => ({
      key: { kind: "skill" as const, name: entry.name },
      targets,
    })),
    ...ledger.agentDefs.map((entry) => ({
      key: { kind: "agent" as const, name: entry.name },
      targets,
    })),
    ...ledger.plugins.map((entry) => ({
      key: { kind: "plugin" as const, name: entry.name },
      targets,
    })),
    ...ledger.bundles.map((entry) => ({
      key: { kind: "bundle" as const, name: entry.name },
      targets,
    })),
  ];
  return { ...emptyFile(), enabled: canonical(enabled) };
}

function ledgerOwns(
  ledger: Ledger | null | undefined,
  key: z.infer<typeof CapabilityKey>,
): boolean {
  if (!ledger) return false;
  switch (key.kind) {
    case "instruction":
      return ledger.instructions.some((entry) => entry.name === key.name);
    case "skill":
      return ledger.skills.some((entry) => entry.name === key.name);
    case "agent":
      return ledger.agentDefs.some((entry) => entry.name === key.name);
    case "plugin":
      return ledger.plugins.some((entry) => entry.name === key.name);
    case "bundle":
      return ledger.bundles.some((entry) => entry.name === key.name);
  }
}

function entryMap(entries: readonly SelectionEntry[]): Map<string, SelectionEntry> {
  const out = new Map<string, SelectionEntry>();
  for (const entry of entries) {
    const id = serializeCapabilityKey(entry.key);
    const existing = out.get(id);
    out.set(id, {
      key: CapabilityKey.parse(entry.key),
      targets: uniqueTargets([...(existing?.targets ?? []), ...entry.targets]),
    });
  }
  return out;
}

function removeTargets(
  entry: SelectionEntry | undefined,
  targets: readonly z.infer<typeof DeployTarget>[],
) {
  if (!entry) return undefined;
  const removed = new Set(targets);
  const remaining = entry.targets.filter((target) => !removed.has(target));
  return remaining.length === 0 ? undefined : { key: entry.key, targets: remaining };
}

export function openSelectionStore(
  path: string,
  options: SelectionStoreOptions = {},
): SelectionStore {
  const rename = options.rename ?? renameSync;
  const fsyncDirectory =
    options.fsyncDirectory ??
    ((directory: string) => {
      const fd = openSync(directory, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });

  const load = (): SelectionFile | undefined => {
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`selection_corrupt: ${String(error)}`);
    }
    const parsed = SelectionFile.safeParse(raw);
    if (parsed.success) return parsed.data;
    if (UninitializedSelectionFile.safeParse(raw).success) return undefined;
    throw new Error(`selection_corrupt: ${parsed.error.message}`);
  };

  const write = (file: SelectionFile): void => {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let renamed = false;
    try {
      const fd = openSync(temporary, "w", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      rename(temporary, path);
      renamed = true;
      fsyncDirectory(directory);
    } finally {
      if (!renamed && existsSync(temporary)) unlinkSync(temporary);
    }
  };

  const initialized = (): SelectionFile => {
    const current = load();
    if (current) return current;
    const initial = seedFile(null);
    write(initial);
    return initial;
  };

  return {
    read: () => {
      const current = load();
      return current ? snapshot(current) : { revision: 0, enabled: [], removalIntents: [] };
    },
    seedOnce: (ledger) => {
      const current = load();
      if (current) return snapshot(current);
      const initial = seedFile(ledger);
      write(initial);
      return snapshot(initial);
    },
    mutate: (body, ledger) => {
      const mutation = SelectionMutation.parse(body);
      const current = initialized();
      if (mutation.expectedRevision !== current.revision) {
        throw new SelectionConflictError(current.revision);
      }
      const enabled = entryMap(current.enabled);
      const removalIntents = entryMap(current.removalIntents);
      for (const change of mutation.changes) {
        const id = serializeCapabilityKey(change.key);
        const targets = uniqueTargets(change.targets);
        if (change.enabled) {
          const old = enabled.get(id);
          enabled.set(id, {
            key: change.key,
            targets: uniqueTargets([...(old?.targets ?? []), ...targets]),
          });
          const remainingIntent = removeTargets(removalIntents.get(id), targets);
          if (remainingIntent) removalIntents.set(id, remainingIntent);
          else removalIntents.delete(id);
          continue;
        }
        const old = enabled.get(id);
        const disabledAnEnabledTarget =
          old?.targets.some((target) => targets.includes(target)) ?? false;
        const remainingEnabled = removeTargets(old, targets);
        if (remainingEnabled) enabled.set(id, remainingEnabled);
        else enabled.delete(id);
        if (disabledAnEnabledTarget || ledgerOwns(ledger, change.key)) {
          const oldIntent = removalIntents.get(id);
          removalIntents.set(id, {
            key: change.key,
            targets: uniqueTargets([...(oldIntent?.targets ?? []), ...targets]),
          });
        }
      }
      const next: SelectionFile = {
        schemaVersion: 1,
        initialized: true,
        revision: current.revision + 1,
        enabled: canonical(enabled.values()),
        removalIntents: canonical(removalIntents.values()),
      };
      write(next);
      return snapshot(next);
    },
    clearRemovalIntents: (expectedRevision, entries) => {
      const current = initialized();
      if (expectedRevision !== current.revision) {
        throw new SelectionConflictError(current.revision);
      }
      const removalIntents = entryMap(current.removalIntents);
      let changed = false;
      for (const entry of entries) {
        const id = serializeCapabilityKey(entry.key);
        const currentIntent = removalIntents.get(id);
        const removesAnIntentTarget =
          currentIntent?.targets.some((target) => entry.targets.includes(target)) ?? false;
        if (!removesAnIntentTarget) continue;
        const remaining = removeTargets(currentIntent, entry.targets);
        if (remaining) removalIntents.set(id, remaining);
        else removalIntents.delete(id);
        changed = true;
      }
      if (!changed) return snapshot(current);
      const next: SelectionFile = {
        ...current,
        revision: current.revision + 1,
        removalIntents: canonical(removalIntents.values()),
      };
      write(next);
      return snapshot(next);
    },
  };
}
