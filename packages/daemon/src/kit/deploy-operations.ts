import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { CapabilityKey } from "@hive/capability-schema";
import { DeployOperationState, type DeployOperationSummary, DeployTarget } from "@hive/contract";
import { z } from "zod";
import { atomicWriteFile, withAdvisoryFileLock } from "../lib/durable-file.ts";
import type { DeployPlan, DeployPlanAction } from "./deploy-plan.ts";

const ArtifactObservation = z.object({
  existence: z.enum(["present", "missing", "error"]),
  hash: z.string().nullable(),
  error: z.literal("read").optional(),
});

const DeployPlanActionSchema = z.object({
  action: z.enum(["add", "update", "remove"]),
  key: CapabilityKey,
  target: DeployTarget,
  sourceId: z.string().optional(),
  contentSha: z.string().optional(),
  renderedHash: z.string().nullable().optional(),
  removalIntentGeneration: z.string().optional(),
  artifact: ArtifactObservation,
});

const InstructionContribution = z.object({
  key: z.object({ kind: z.literal("instruction"), name: z.string() }),
  sourceId: z.string(),
  contentSha: z.string(),
});

const DeployPlanSchema = z.object({
  selectionRevision: z.number().int().nonnegative(),
  sourceRegistryRevision: z.number().int().nonnegative(),
  mirrors: z.array(
    z.object({
      sourceId: z.string(),
      precedence: z.number().int(),
      identity: z.string().nullable(),
      error: z.literal("unavailable").optional(),
    }),
  ),
  ledger: z.object({ revision: z.number().int().nonnegative().nullable(), identity: z.string() }),
  deploymentStateRevision: z.number().int().nonnegative(),
  actions: z.array(DeployPlanActionSchema),
  instructionWrites: z.array(
    z.object({
      target: DeployTarget,
      contributions: z.array(InstructionContribution),
      renderedHash: z.string(),
      artifact: ArtifactObservation,
    }),
  ),
  blocked: z.array(
    z.object({
      kind: z.literal("instruction"),
      target: DeployTarget,
      keys: z.array(CapabilityKey),
    }),
  ),
});

const StagedAction = z.object({
  action: z.enum(["add", "update", "remove"]),
  key: CapabilityKey,
  target: DeployTarget,
});

const StagedFile = z.object({ rel: z.string(), content: z.string() });

const StagedInstructionTask = z.object({
  type: z.literal("instruction"),
  target: DeployTarget,
  actions: z.array(StagedAction),
  contributions: z.array(InstructionContribution),
  renderedHash: z.string().nullable(),
  content: z.string().nullable(),
});

const StagedSkillTask = z.object({
  type: z.literal("skill"),
  action: z.enum(["add", "update"]),
  key: z.object({ kind: z.literal("skill"), name: z.string() }),
  target: DeployTarget,
  sourceId: z.string(),
  contentSha: z.string(),
  renderedHash: z.string(),
  files: z.array(StagedFile),
});

const StagedAgentTask = z.object({
  type: z.literal("agent"),
  action: z.enum(["add", "update"]),
  key: z.object({ kind: z.literal("agent"), name: z.string() }),
  target: DeployTarget,
  sourceId: z.string(),
  contentSha: z.string(),
  renderedHash: z.string(),
  content: z.string(),
});

// Kept only to recover an operation accepted by an older build. Current staging
// rejects installer-owned work before persistence, and execution rejects these
// legacy skipped tasks rather than turning them into success.
const StagedPluginTask = z.object({
  type: z.literal("plugin"),
  action: z.enum(["add", "update"]),
  key: z.object({ kind: z.literal("plugin"), name: z.string() }),
  target: z.literal("claude"),
  sourceId: z.string(),
  contentSha: z.string(),
  execution: z.literal("skipped").default("skipped"),
});

const StagedBundleTask = z.object({
  type: z.literal("bundle"),
  action: z.enum(["add", "update"]),
  key: z.object({ kind: z.literal("bundle"), name: z.string() }),
  target: DeployTarget,
  sourceId: z.string(),
  contentSha: z.string(),
  execution: z.literal("skipped").default("skipped"),
  pin: z.string().nullable(),
});

const StagedRemovalTask = z.object({
  type: z.literal("remove"),
  action: z.literal("remove"),
  key: z.union([
    z.object({ kind: z.literal("skill"), name: z.string() }),
    z.object({ kind: z.literal("agent"), name: z.string() }),
  ]),
  target: DeployTarget,
});

export const StagedDeployPayloadSchema = z.object({
  tasks: z.array(
    z.discriminatedUnion("type", [
      StagedInstructionTask,
      StagedSkillTask,
      StagedAgentTask,
      StagedPluginTask,
      StagedBundleTask,
      StagedRemovalTask,
    ]),
  ),
  metadata: z.record(z.string()).default({}),
});
export type StagedDeployPayload = z.infer<typeof StagedDeployPayloadSchema>;
export type StagedDeployTask = StagedDeployPayload["tasks"][number];

export const DeployOperationOutcomeSchema = z.object({
  action: z.enum(["add", "update", "remove"]),
  key: CapabilityKey,
  target: DeployTarget,
  outcome: z.enum(["succeeded", "failed"]),
  attemptedAt: z.number().int().nonnegative(),
  code: z.string().max(80).optional(),
  detail: z.string().max(512).optional(),
});
export type DeployOperationOutcome = z.infer<typeof DeployOperationOutcomeSchema>;

export const DeployExecutionPhase = z.enum([
  "applying",
  "ledger_pending",
  "ledger_committed",
  "finalizing",
  "finished",
]);
export type DeployExecutionPhase = z.infer<typeof DeployExecutionPhase>;

const PersistedDeployOperationSummary = z.object({
  operationId: z.string().min(1),
  state: DeployOperationState,
  acceptedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  selectionRevision: z.number().int().nonnegative(),
  planToken: z.string().min(1),
  auditState: z.enum(["pending", "recorded"]).default("recorded"),
  executionPhase: DeployExecutionPhase.default("applying"),
  provisionalOutcomes: z.array(DeployOperationOutcomeSchema).default([]),
  outcomes: z.array(DeployOperationOutcomeSchema).default([]),
  recoveryPendingActions: z.array(DeployPlanActionSchema).default([]),
  errorCode: z.string().max(80).optional(),
});
type PersistedDeployOperationSummary = z.infer<typeof PersistedDeployOperationSummary>;

const DeployOperationPayload = z.object({
  operationId: z.string().min(1),
  plan: DeployPlanSchema,
  staged: StagedDeployPayloadSchema,
});
type DeployOperationPayload = z.infer<typeof DeployOperationPayload>;

const LegacyPersistedDeployOperation = PersistedDeployOperationSummary.omit({
  executionPhase: true,
  provisionalOutcomes: true,
}).extend({
  plan: DeployPlanSchema,
  staged: StagedDeployPayloadSchema,
});

const LegacyDeployOperationsFile = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  operations: z.array(LegacyPersistedDeployOperation),
});

const DeployOperationsFile = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  operations: z.array(PersistedDeployOperationSummary),
});
type DeployOperationsFile = z.infer<typeof DeployOperationsFile>;

export type DeployOperation = PersistedDeployOperationSummary &
  Omit<DeployOperationPayload, "plan"> & {
    plan: DeployPlan;
    unfinishedActions?: DeployPlanAction[];
  };

export type QueuedDeployOperation = {
  operationId: string;
  acceptedAt: number;
  selectionRevision: number;
  planToken: string;
  plan: DeployPlan;
  staged: StagedDeployPayload;
  auditState?: "pending" | "recorded";
};

export type DeployOperationStoreOptions = {
  now?: () => number;
  lockTimeoutMs?: number;
  rename?: (oldPath: string, newPath: string) => void;
  fsyncDirectory?: (directory: string) => void;
  write?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
  onInterrupted?: (operation: DeployOperation) => void;
  summaryRetention?: number;
  payloadRetention?: number;
};

export class DeployOperationStoreError extends Error {
  readonly code:
    | "operation_store_corrupt"
    | "operation_store_write_failed"
    | "operation_store_lock_failed"
    | "operation_store_lock_timeout"
    | "operation_active"
    | "operation_not_found"
    | "operation_invalid_transition";
  readonly operationId?: string;

  constructor(code: DeployOperationStoreError["code"], operationId?: string) {
    super(code);
    this.name = "DeployOperationStoreError";
    this.code = code;
    if (operationId !== undefined) this.operationId = operationId;
  }
}

export type DeployOperationStore = {
  readonly path: string;
  list(): DeployOperation[];
  read(operationId: string): DeployOperation | undefined;
  activeSummary(): DeployOperationSummary | null;
  lastSummary(): DeployOperationSummary | null;
  recoverable(): DeployOperation[];
  createQueued(input: QueuedDeployOperation): DeployOperation;
  markRunning(operationId: string): DeployOperation;
  recordProvisionalOutcomes(
    operationId: string,
    outcomes: readonly DeployOperationOutcome[],
  ): DeployOperation;
  markLedgerPending(operationId: string): DeployOperation;
  markLedgerCommitted(operationId: string): DeployOperation;
  markFinalizing(operationId: string): DeployOperation;
  recordOutcomes(operationId: string, outcomes: readonly DeployOperationOutcome[]): DeployOperation;
  markAuditRecorded(operationId: string): DeployOperation;
  fail(operationId: string, errorCode: string): DeployOperation;
  finish(operationId: string, state: "completed" | "failed", errorCode?: string): DeployOperation;
};

function emptyFile(): DeployOperationsFile {
  return { schemaVersion: 2, revision: 0, operations: [] };
}

function actionId(action: Pick<DeployPlanAction, "key" | "target">): string {
  return `${action.key.kind}\u0000${action.key.name}\u0000${action.target}`;
}

function mergeOutcomes(
  current: readonly DeployOperationOutcome[],
  next: readonly DeployOperationOutcome[],
): DeployOperationOutcome[] {
  const byAction = new Map(current.map((outcome) => [actionId(outcome), outcome]));
  for (const outcome of next) {
    const parsed = DeployOperationOutcomeSchema.parse(outcome);
    byAction.set(actionId(parsed), parsed);
  }
  return [...byAction.values()];
}

function provisionalCoversPlan(
  operation: PersistedDeployOperationSummary,
  payload: DeployOperationPayload,
): boolean {
  const recorded = new Set(operation.provisionalOutcomes.map(actionId));
  return payload.plan.actions.every((action) => recorded.has(actionId(action)));
}

function wireSummary(
  operation: PersistedDeployOperationSummary | undefined,
): DeployOperationSummary | null {
  if (!operation) return null;
  return {
    operationId: operation.operationId,
    state: operation.state,
    acceptedAt: operation.acceptedAt,
    selectionRevision: operation.selectionRevision,
    planToken: operation.planToken,
    ...(operation.completedAt !== undefined ? { completedAt: operation.completedAt } : {}),
  };
}

function isActive(operation: PersistedDeployOperationSummary): boolean {
  return operation.state === "queued" || operation.state === "running";
}

function needsRecoveryPayload(operation: PersistedDeployOperationSummary): boolean {
  return (
    isActive(operation) ||
    operation.recoveryPendingActions.length > 0 ||
    operation.executionPhase === "ledger_pending" ||
    operation.executionPhase === "ledger_committed" ||
    operation.executionPhase === "finalizing"
  );
}

export function openDeployOperationStore(
  path: string,
  options: DeployOperationStoreOptions = {},
): DeployOperationStore {
  const now = options.now ?? Date.now;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  const summaryRetention = Math.max(0, options.summaryRetention ?? 100);
  const payloadRetention = Math.max(0, options.payloadRetention ?? 20);
  const stem = basename(path, extname(path));
  const payloadDirectory = join(dirname(path), `${stem}.payloads`);
  const payloadPath = (operationId: string): string =>
    join(payloadDirectory, `${createHash("sha256").update(operationId).digest("hex")}.json`);

  const writeIndex = (file: DeployOperationsFile): void => {
    try {
      atomicWriteFile(path, Buffer.from(`${JSON.stringify(file, null, 2)}\n`), options);
    } catch {
      throw new DeployOperationStoreError("operation_store_write_failed");
    }
  };

  const writePayload = (payload: DeployOperationPayload): void => {
    try {
      mkdirSync(payloadDirectory, { recursive: true });
      atomicWriteFile(
        payloadPath(payload.operationId),
        Buffer.from(`${JSON.stringify(DeployOperationPayload.parse(payload), null, 2)}\n`),
        options,
      );
    } catch {
      throw new DeployOperationStoreError("operation_store_write_failed", payload.operationId);
    }
  };

  const readPayload = (operationId: string): DeployOperationPayload | undefined => {
    const target = payloadPath(operationId);
    if (!existsSync(target)) return undefined;
    try {
      const payload = DeployOperationPayload.parse(JSON.parse(readFileSync(target, "utf8")));
      if (payload.operationId !== operationId) {
        throw new DeployOperationStoreError("operation_store_corrupt", operationId);
      }
      return payload;
    } catch {
      throw new DeployOperationStoreError("operation_store_corrupt", operationId);
    }
  };

  const compact = (
    operations: readonly PersistedDeployOperationSummary[],
  ): { operations: PersistedDeployOperationSummary[]; deletePayloads: string[] } => {
    const terminal = operations.filter((operation) => !needsRecoveryPayload(operation));
    const keepSummary = new Set(
      terminal
        .slice(Math.max(0, terminal.length - summaryRetention))
        .map((operation) => operation.operationId),
    );
    const keepPayload = new Set(
      terminal
        .slice(Math.max(0, terminal.length - payloadRetention))
        .map((operation) => operation.operationId),
    );
    const kept = operations.filter(
      (operation) => needsRecoveryPayload(operation) || keepSummary.has(operation.operationId),
    );
    const deletePayloads = operations
      .filter(
        (operation) => !needsRecoveryPayload(operation) && !keepPayload.has(operation.operationId),
      )
      .map((operation) => operation.operationId);
    return { operations: kept, deletePayloads };
  };

  const migrateLegacy = (
    legacy: z.infer<typeof LegacyDeployOperationsFile>,
  ): DeployOperationsFile => {
    const entries = legacy.operations.map((operation, index) => {
      const recoverRecordedOutcomes =
        index === legacy.operations.length - 1 &&
        (operation.state === "running" ||
          operation.state === "failed" ||
          operation.state === "interrupted") &&
        operation.auditState === "recorded" &&
        operation.outcomes.length > 0;
      return {
        payload: {
          operationId: operation.operationId,
          plan: operation.plan,
          staged: operation.staged,
        },
        summary: PersistedDeployOperationSummary.parse({
          operationId: operation.operationId,
          state: operation.state,
          acceptedAt: operation.acceptedAt,
          ...(operation.completedAt !== undefined ? { completedAt: operation.completedAt } : {}),
          selectionRevision: operation.selectionRevision,
          planToken: operation.planToken,
          auditState: operation.auditState,
          executionPhase: recoverRecordedOutcomes
            ? "ledger_pending"
            : operation.state === "completed" || operation.state === "failed"
              ? "finished"
              : "applying",
          provisionalOutcomes: recoverRecordedOutcomes ? operation.outcomes : [],
          outcomes: operation.outcomes,
          recoveryPendingActions: operation.recoveryPendingActions,
          ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
        }),
      };
    });
    const compacted = compact(entries.map((entry) => entry.summary));
    const retainedSummaries = new Set(
      compacted.operations.map((operation) => operation.operationId),
    );
    const deletedPayloads = new Set(compacted.deletePayloads);
    for (const entry of entries) {
      if (
        retainedSummaries.has(entry.summary.operationId) &&
        !deletedPayloads.has(entry.summary.operationId)
      ) {
        writePayload(entry.payload);
      }
    }
    const migrated = DeployOperationsFile.parse({
      schemaVersion: 2,
      revision: legacy.revision,
      operations: compacted.operations,
    });
    writeIndex(migrated);
    return migrated;
  };

  const load = (): DeployOperationsFile => {
    if (!existsSync(path)) return emptyFile();
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new DeployOperationStoreError("operation_store_corrupt");
    }
    const current = DeployOperationsFile.safeParse(value);
    if (current.success) return current.data;
    const legacy = LegacyDeployOperationsFile.safeParse(value);
    if (legacy.success) return migrateLegacy(legacy.data);
    throw new DeployOperationStoreError("operation_store_corrupt");
  };

  const compose = (
    operation: PersistedDeployOperationSummary,
    allowMissing = false,
  ): DeployOperation | undefined => {
    const payload = readPayload(operation.operationId);
    if (!payload) {
      if (allowMissing && !needsRecoveryPayload(operation)) return undefined;
      throw new DeployOperationStoreError("operation_store_corrupt", operation.operationId);
    }
    return {
      ...PersistedDeployOperationSummary.parse(operation),
      ...payload,
      plan: payload.plan as DeployPlan,
    };
  };

  const withLock = <A>(work: (file: DeployOperationsFile) => A): A => {
    try {
      return withAdvisoryFileLock(path, lockTimeoutMs, () => work(load()));
    } catch (error) {
      if (error instanceof DeployOperationStoreError) throw error;
      throw new DeployOperationStoreError("operation_store_lock_failed");
    }
  };

  const mutate = <A>(work: (file: DeployOperationsFile) => A): A => {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return withLock(work);
      } catch (error) {
        last = error;
        if (
          !(error instanceof DeployOperationStoreError) ||
          (error.code !== "operation_store_write_failed" &&
            error.code !== "operation_store_lock_failed" &&
            error.code !== "operation_store_lock_timeout")
        ) {
          throw error;
        }
      }
    }
    throw last;
  };

  const deletePayloads = (operationIds: readonly string[]): void => {
    for (const operationId of operationIds) {
      try {
        unlinkSync(payloadPath(operationId));
      } catch {
        // The bounded index is authoritative; an orphan payload is swept below.
      }
    }
  };

  const sweepOrphanPayloads = (): void => {
    if (!existsSync(payloadDirectory)) return;
    withLock((file) => {
      const referenced = new Set(
        file.operations.map((operation) => payloadPath(operation.operationId)),
      );
      for (const entry of readdirSync(payloadDirectory)) {
        const candidate = join(payloadDirectory, entry);
        if (referenced.has(candidate) || entry.includes(".tmp-")) continue;
        try {
          unlinkSync(candidate);
        } catch {
          // A later open retries bounded orphan cleanup.
        }
      }
    });
  };

  const replace = (
    operationId: string,
    update: (operation: PersistedDeployOperationSummary) => PersistedDeployOperationSummary,
  ): DeployOperation => {
    const result = mutate((file) => {
      const index = file.operations.findIndex((operation) => operation.operationId === operationId);
      const current = file.operations[index];
      if (!current) throw new DeployOperationStoreError("operation_not_found", operationId);
      const next = PersistedDeployOperationSummary.parse(update(current));
      const operations = [...file.operations];
      operations[index] = next;
      const compacted = compact(operations);
      writeIndex({ ...file, revision: file.revision + 1, operations: compacted.operations });
      return { next, deletePayloads: compacted.deletePayloads };
    });
    const composed = compose(result.next);
    if (!composed) throw new DeployOperationStoreError("operation_store_corrupt", operationId);
    deletePayloads(result.deletePayloads);
    return composed;
  };

  mutate((file) => {
    let changed = false;
    const operations = file.operations.map((operation) => {
      if (!isActive(operation)) return operation;
      changed = true;
      if (operation.state === "queued" && operation.auditState === "pending") {
        return PersistedDeployOperationSummary.parse({
          ...operation,
          state: "failed",
          completedAt: now(),
          errorCode: "audit_interrupted",
          executionPhase: "finished",
          recoveryPendingActions: [],
        });
      }
      if (
        operation.executionPhase === "ledger_pending" ||
        operation.executionPhase === "ledger_committed" ||
        operation.executionPhase === "finalizing"
      ) {
        return PersistedDeployOperationSummary.parse({
          ...operation,
          state: "interrupted",
          completedAt: now(),
          errorCode: "interrupted",
          recoveryPendingActions: [],
        });
      }
      const payload = compose(operation);
      if (!payload)
        throw new DeployOperationStoreError("operation_store_corrupt", operation.operationId);
      if (
        operation.state === "running" &&
        operation.executionPhase === "applying" &&
        provisionalCoversPlan(operation, payload)
      ) {
        return PersistedDeployOperationSummary.parse({
          ...operation,
          state: "interrupted",
          completedAt: now(),
          errorCode: "interrupted",
          executionPhase: "ledger_pending",
          recoveryPendingActions: [],
        });
      }
      const finished = new Set(operation.outcomes.map(actionId));
      return PersistedDeployOperationSummary.parse({
        ...operation,
        state: "interrupted",
        completedAt: now(),
        errorCode: "interrupted",
        executionPhase: "finished",
        recoveryPendingActions: payload.plan.actions.filter(
          (action) => !finished.has(actionId(action)),
        ),
      });
    });
    if (changed) {
      const compacted = compact(operations);
      writeIndex({ ...file, revision: file.revision + 1, operations: compacted.operations });
      deletePayloads(compacted.deletePayloads);
    }
  });

  if (options.onInterrupted) {
    for (const operation of load().operations) {
      for (const action of operation.recoveryPendingActions) {
        try {
          const full = compose(operation);
          if (!full)
            throw new DeployOperationStoreError("operation_store_corrupt", operation.operationId);
          options.onInterrupted({
            ...full,
            unfinishedActions: [action as DeployPlanAction],
          });
          replace(operation.operationId, (current) => ({
            ...current,
            recoveryPendingActions: current.recoveryPendingActions.filter(
              (candidate) => actionId(candidate) !== actionId(action as DeployPlanAction),
            ),
          }));
        } catch {
          // Pending recovery remains durable and is retried on the next startup.
        }
      }
    }
  }

  sweepOrphanPayloads();

  const markPhase = (operationId: string, executionPhase: DeployExecutionPhase): DeployOperation =>
    replace(operationId, (operation) => {
      if (
        operation.state !== "running" &&
        !(
          (operation.state === "failed" || operation.state === "interrupted") &&
          operation.executionPhase !== "finished"
        )
      ) {
        throw new DeployOperationStoreError("operation_invalid_transition", operationId);
      }
      return { ...operation, executionPhase };
    });

  return {
    path,
    list: () =>
      load().operations.flatMap((operation) => {
        const full = compose(operation, true);
        return full ? [full] : [];
      }),
    read: (operationId) => {
      const found = load().operations.find((operation) => operation.operationId === operationId);
      return found ? compose(found, true) : undefined;
    },
    activeSummary: () =>
      wireSummary([...load().operations].reverse().find((operation) => isActive(operation))),
    lastSummary: () => wireSummary(load().operations.at(-1)),
    recoverable: () =>
      load().operations.flatMap((operation) => {
        if (
          operation.executionPhase !== "ledger_pending" &&
          operation.executionPhase !== "ledger_committed" &&
          operation.executionPhase !== "finalizing"
        ) {
          return [];
        }
        const full = compose(operation);
        return full ? [full] : [];
      }),
    createQueued: (input) =>
      mutate((file) => {
        const existing = file.operations.find(
          (operation) => operation.operationId === input.operationId,
        );
        if (existing) {
          const full = compose(existing);
          if (!full)
            throw new DeployOperationStoreError("operation_store_corrupt", input.operationId);
          return full;
        }
        const active = [...file.operations].reverse().find((operation) => isActive(operation));
        if (active) throw new DeployOperationStoreError("operation_active", active.operationId);
        writePayload({ operationId: input.operationId, plan: input.plan, staged: input.staged });
        const operation = PersistedDeployOperationSummary.parse({
          operationId: input.operationId,
          state: "queued",
          acceptedAt: input.acceptedAt,
          selectionRevision: input.selectionRevision,
          planToken: input.planToken,
          auditState: input.auditState ?? "recorded",
          executionPhase: "applying",
          provisionalOutcomes: [],
          outcomes: [],
          recoveryPendingActions: [],
        });
        writeIndex({
          ...file,
          revision: file.revision + 1,
          operations: [...file.operations, operation],
        });
        const full = compose(operation);
        if (!full)
          throw new DeployOperationStoreError("operation_store_corrupt", input.operationId);
        return full;
      }),
    markRunning: (operationId) =>
      replace(operationId, (operation) => {
        if (operation.state === "running") return operation;
        if (operation.state !== "queued" || operation.auditState !== "recorded") {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        return { ...operation, state: "running", executionPhase: "applying" };
      }),
    recordProvisionalOutcomes: (operationId, outcomes) =>
      replace(operationId, (operation) => {
        if (operation.state !== "running" || operation.executionPhase !== "applying") {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        return {
          ...operation,
          provisionalOutcomes: mergeOutcomes(operation.provisionalOutcomes, outcomes),
        };
      }),
    markLedgerPending: (operationId) => markPhase(operationId, "ledger_pending"),
    markLedgerCommitted: (operationId) => markPhase(operationId, "ledger_committed"),
    markFinalizing: (operationId) => markPhase(operationId, "finalizing"),
    recordOutcomes: (operationId, outcomes) =>
      replace(operationId, (operation) => {
        const recoverableTerminal =
          (operation.state === "failed" || operation.state === "interrupted") &&
          operation.executionPhase !== "finished";
        if (operation.state !== "running" && !recoverableTerminal) {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        return { ...operation, outcomes: mergeOutcomes(operation.outcomes, outcomes) };
      }),
    markAuditRecorded: (operationId) =>
      replace(operationId, (operation) => {
        if (operation.auditState === "recorded") return operation;
        if (operation.state !== "queued") {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        return { ...operation, auditState: "recorded" };
      }),
    fail: (operationId, errorCode) =>
      replace(operationId, (operation) => {
        if (
          operation.state === "completed" ||
          operation.state === "failed" ||
          operation.state === "interrupted"
        ) {
          return operation;
        }
        const payload = compose(operation);
        if (!payload) {
          throw new DeployOperationStoreError("operation_store_corrupt", operationId);
        }
        const ledgerReady =
          operation.state === "running" &&
          operation.auditState === "recorded" &&
          operation.executionPhase === "applying" &&
          provisionalCoversPlan(operation, payload);
        return {
          ...operation,
          state: "failed",
          completedAt: now(),
          errorCode,
          ...(operation.executionPhase === "applying"
            ? { executionPhase: ledgerReady ? ("ledger_pending" as const) : ("finished" as const) }
            : {}),
        };
      }),
    finish: (operationId, state, errorCode) =>
      replace(operationId, (operation) => {
        if (operation.state === state && operation.executionPhase === "finished") return operation;
        const recoverableTerminal =
          (operation.state === "failed" || operation.state === "interrupted") &&
          operation.executionPhase !== "finished";
        if (operation.state !== "running" && !recoverableTerminal) {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        return {
          ...operation,
          state,
          executionPhase: "finished",
          completedAt: now(),
          ...(errorCode ? { errorCode } : {}),
        };
      }),
  };
}
