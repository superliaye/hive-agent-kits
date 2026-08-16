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
import { syncDirectoryForDurability } from "../lib/durable-file.ts";
import { applicableTargetSet } from "./capability-targets.ts";

const SelectionEntry = z.object({ key: CapabilityKey, targets: z.array(DeployTarget).min(1) });
const RemovalIntent = z.object({
  key: CapabilityKey,
  targets: z.tuple([DeployTarget]),
  generation: z.string().min(1),
});

export const SelectionFile = z.object({
  schemaVersion: z.literal(3),
  initialized: z.literal(true),
  revision: z.number().int().nonnegative(),
  enabled: z.array(SelectionEntry),
  removalIntents: z.array(RemovalIntent),
});

const LegacySelectionFileV2 = z.object({
  schemaVersion: z.literal(2),
  initialized: z.literal(true),
  revision: z.number().int().nonnegative(),
  enabled: z.array(SelectionEntry),
  removalIntents: z.array(RemovalIntent),
});

const LegacySelectionFile = z.object({
  schemaVersion: z.literal(1),
  initialized: z.literal(true),
  revision: z.number().int().nonnegative(),
  enabled: z.array(SelectionEntry),
  removalIntents: z.array(SelectionEntry),
});

const UninitializedSelectionFile = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    initialized: z.literal(false),
  })
  .strict();

type SelectionEntry = z.infer<typeof SelectionEntry>;
type RemovalIntent = z.infer<typeof RemovalIntent>;
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

export class SelectionTargetNotApplicableError extends Error {
  readonly code = "selection_target_not_applicable";

  constructor() {
    super("selection_target_not_applicable");
    this.name = "SelectionTargetNotApplicableError";
  }
}

export type SelectionStoreOptions = {
  rename?: (oldPath: string, newPath: string) => void;
  fsyncDirectory?: (directory: string) => void;
  write?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
  generation?: () => string;
};

export type PreparedSelectionMutation = {
  before: SelectionSnapshotType;
  after: SelectionSnapshotType;
  commit(): SelectionSnapshotType;
};

export type SelectionStore = {
  read(): SelectionSnapshotType;
  seedOnce(ledger: Ledger | null): SelectionSnapshotType;
  prepareMutation(
    body: z.input<typeof SelectionMutation>,
    ledger?: Ledger | null,
  ): PreparedSelectionMutation;
  mutate(body: z.input<typeof SelectionMutation>, ledger?: Ledger | null): SelectionSnapshotType;
  // Internal seam for a later successful Deploy removal outcome. It changes only
  // matching intents and never lets Deployment State author Selection.
  clearRemovalIntents(
    entries: readonly { key: SelectionEntry["key"]; target: DeployTarget; generation: string }[],
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
      targets: uniqueTargets(entry.targets).filter((target) =>
        applicableTargetSet(entry.key).has(target),
      ),
    }))
    .filter((entry) => entry.targets.length > 0)
    .sort((a, b) => serializeCapabilityKey(a.key).localeCompare(serializeCapabilityKey(b.key)));
}

function intentId(key: SelectionEntry["key"], target: DeployTarget): string {
  return `${serializeCapabilityKey(key)}\u0000${target}`;
}

function canonicalIntents(entries: Iterable<RemovalIntent>): RemovalIntent[] {
  return [...entries]
    .filter((entry) => applicableTargetSet(entry.key).has(entry.targets[0]))
    .map((entry) => RemovalIntent.parse(entry))
    .sort((left, right) =>
      intentId(left.key, left.targets[0]).localeCompare(intentId(right.key, right.targets[0])),
    );
}

function emptyFile(): SelectionFile {
  return { schemaVersion: 3, initialized: true, revision: 1, enabled: [], removalIntents: [] };
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
  target: z.infer<typeof DeployTarget>,
): boolean {
  if (!ledger?.agents.includes(target)) return false;
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

function intentMap(entries: readonly RemovalIntent[]): Map<string, RemovalIntent> {
  return new Map(entries.map((entry) => [intentId(entry.key, entry.targets[0]), entry]));
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
  const writeBytes =
    options.write ??
    ((fd: number, bytes: Uint8Array, offset: number, length: number) =>
      writeSync(fd, bytes, offset, length));
  const fsyncDirectory = options.fsyncDirectory ?? syncDirectoryForDurability;
  const generation = options.generation ?? (() => crypto.randomUUID());

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
    const legacyV2 = LegacySelectionFileV2.safeParse(raw);
    if (legacyV2.success) {
      const migrated: SelectionFile = {
        schemaVersion: 3,
        initialized: true,
        revision: legacyV2.data.revision,
        enabled: canonical(legacyV2.data.enabled),
        removalIntents: canonicalIntents(legacyV2.data.removalIntents),
      };
      write(migrated);
      return migrated;
    }
    const legacy = LegacySelectionFile.safeParse(raw);
    if (legacy.success) {
      const migrated: SelectionFile = {
        schemaVersion: 3,
        initialized: true,
        revision: legacy.data.revision,
        enabled: canonical(legacy.data.enabled),
        removalIntents: canonicalIntents(
          legacy.data.removalIntents.flatMap((entry) =>
            entry.targets.map((target) => ({
              key: entry.key,
              targets: [target] as [DeployTarget],
              generation: generation(),
            })),
          ),
        ),
      };
      write(migrated);
      return migrated;
    }
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
        const bytes = Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeBytes(fd, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
            throw new Error("selection_write_failed: write made no progress");
          }
          offset += written;
        }
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

  const prepareMutation = (
    body: z.input<typeof SelectionMutation>,
    ledger?: Ledger | null,
  ): PreparedSelectionMutation => {
    const mutation = SelectionMutation.parse(body);
    const current = initialized();
    if (mutation.expectedRevision !== current.revision) {
      throw new SelectionConflictError(current.revision);
    }
    const enabled = entryMap(current.enabled);
    const removalIntents = intentMap(current.removalIntents);
    for (const change of mutation.changes) {
      const id = serializeCapabilityKey(change.key);
      const targets = uniqueTargets(change.targets);
      const applicable = applicableTargetSet(change.key);
      if (targets.some((target) => !applicable.has(target))) {
        throw new SelectionTargetNotApplicableError();
      }
      if (change.enabled) {
        const old = enabled.get(id);
        enabled.set(id, {
          key: change.key,
          targets: uniqueTargets([...(old?.targets ?? []), ...targets]),
        });
        for (const target of targets) removalIntents.delete(intentId(change.key, target));
        continue;
      }
      const old = enabled.get(id);
      const previouslyEnabled = new Set(old?.targets ?? []);
      const remainingEnabled = removeTargets(old, targets);
      if (remainingEnabled) enabled.set(id, remainingEnabled);
      else enabled.delete(id);
      for (const target of targets) {
        if (!previouslyEnabled.has(target) && !ledgerOwns(ledger, change.key, target)) continue;
        const targetId = intentId(change.key, target);
        if (removalIntents.has(targetId)) continue;
        removalIntents.set(targetId, {
          key: change.key,
          targets: [target],
          generation: generation(),
        });
      }
    }
    const next: SelectionFile = {
      schemaVersion: 3,
      initialized: true,
      revision: current.revision + 1,
      enabled: canonical(enabled.values()),
      removalIntents: canonicalIntents(removalIntents.values()),
    };
    let committed = false;
    return {
      before: snapshot(current),
      after: snapshot(next),
      commit: () => {
        if (committed) return snapshot(next);
        const latest = initialized();
        if (latest.revision !== current.revision) {
          throw new SelectionConflictError(latest.revision);
        }
        write(next);
        committed = true;
        return snapshot(next);
      },
    };
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
    prepareMutation,
    mutate: (body, ledger) => prepareMutation(body, ledger).commit(),
    clearRemovalIntents: (entries) => {
      const current = initialized();
      const removalIntents = intentMap(current.removalIntents);
      let changed = false;
      for (const entry of entries) {
        const id = intentId(entry.key, entry.target);
        const currentIntent = removalIntents.get(id);
        if (currentIntent?.generation !== entry.generation) continue;
        removalIntents.delete(id);
        changed = true;
      }
      if (!changed) return snapshot(current);
      const next: SelectionFile = {
        ...current,
        revision: current.revision + 1,
        removalIntents: canonicalIntents(removalIntents.values()),
      };
      write(next);
      return snapshot(next);
    },
  };
}
