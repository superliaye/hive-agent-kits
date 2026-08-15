import { existsSync, readFileSync } from "node:fs";
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

const PersistedDeployOperation = z.object({
  operationId: z.string().min(1),
  state: DeployOperationState,
  acceptedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  selectionRevision: z.number().int().nonnegative(),
  planToken: z.string().min(1),
  plan: DeployPlanSchema,
  staged: StagedDeployPayloadSchema,
  auditState: z.enum(["pending", "recorded"]).default("recorded"),
  outcomes: z.array(DeployOperationOutcomeSchema).default([]),
  recoveryPendingActions: z.array(DeployPlanActionSchema).default([]),
  errorCode: z.string().max(80).optional(),
});

type PersistedDeployOperation = z.infer<typeof PersistedDeployOperation>;
export type DeployOperation = Omit<PersistedDeployOperation, "plan"> & {
  plan: DeployPlan;
  unfinishedActions?: DeployPlanAction[];
};

const DeployOperationsFile = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  operations: z.array(PersistedDeployOperation),
});
type DeployOperationsFile = z.infer<typeof DeployOperationsFile>;

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
  createQueued(input: QueuedDeployOperation): DeployOperation;
  markRunning(operationId: string): DeployOperation;
  recordOutcomes(operationId: string, outcomes: readonly DeployOperationOutcome[]): DeployOperation;
  markAuditRecorded(operationId: string): DeployOperation;
  fail(operationId: string, errorCode: string): DeployOperation;
  finish(operationId: string, state: "completed" | "failed", errorCode?: string): DeployOperation;
};

function emptyFile(): DeployOperationsFile {
  return { schemaVersion: 1, revision: 0, operations: [] };
}

function cloneOperation(operation: PersistedDeployOperation): DeployOperation {
  const cloned = PersistedDeployOperation.parse(operation);
  return { ...cloned, plan: cloned.plan as DeployPlan };
}

function summary(operation: PersistedDeployOperation | undefined): DeployOperationSummary | null {
  if (!operation) return null;
  return {
    operationId: operation.operationId,
    state: operation.state,
    acceptedAt: operation.acceptedAt,
    ...(operation.completedAt !== undefined ? { completedAt: operation.completedAt } : {}),
  };
}

function actionId(action: Pick<DeployPlanAction, "key" | "target">): string {
  return `${action.key.kind}\u0000${action.key.name}\u0000${action.target}`;
}

export function openDeployOperationStore(
  path: string,
  options: DeployOperationStoreOptions = {},
): DeployOperationStore {
  const now = options.now ?? Date.now;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;

  const load = (): DeployOperationsFile => {
    if (!existsSync(path)) return emptyFile();
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new DeployOperationStoreError("operation_store_corrupt");
    }
    const parsed = DeployOperationsFile.safeParse(value);
    if (!parsed.success) throw new DeployOperationStoreError("operation_store_corrupt");
    return parsed.data;
  };

  const write = (file: DeployOperationsFile): void => {
    try {
      atomicWriteFile(path, Buffer.from(`${JSON.stringify(file, null, 2)}\n`), options);
    } catch {
      throw new DeployOperationStoreError("operation_store_write_failed");
    }
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

  const replace = (
    operationId: string,
    update: (operation: PersistedDeployOperation) => PersistedDeployOperation,
  ): DeployOperation =>
    mutate((file) => {
      const index = file.operations.findIndex((operation) => operation.operationId === operationId);
      const current = file.operations[index];
      if (!current) throw new DeployOperationStoreError("operation_not_found", operationId);
      const next = PersistedDeployOperation.parse(update(current));
      const operations = [...file.operations];
      operations[index] = next;
      write({ ...file, revision: file.revision + 1, operations });
      return cloneOperation(next);
    });

  mutate((file) => {
    let changed = false;
    const operations = file.operations.map((operation) => {
      if (operation.state !== "queued" && operation.state !== "running") return operation;
      changed = true;
      if (operation.state === "queued" && operation.auditState === "pending") {
        return PersistedDeployOperation.parse({
          ...operation,
          state: "failed",
          completedAt: now(),
          errorCode: "audit_interrupted",
          recoveryPendingActions: [],
        });
      }
      const finished = new Set(operation.outcomes.map(actionId));
      return PersistedDeployOperation.parse({
        ...operation,
        state: "interrupted",
        completedAt: now(),
        errorCode: "interrupted",
        recoveryPendingActions: operation.plan.actions.filter(
          (action) => !finished.has(actionId(action)),
        ),
      });
    });
    if (changed) write({ ...file, revision: file.revision + 1, operations });
  });

  if (options.onInterrupted) {
    for (const operation of load().operations) {
      for (const action of operation.recoveryPendingActions) {
        try {
          options.onInterrupted({
            ...cloneOperation(operation),
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

  return {
    path,
    list: () => load().operations.map(cloneOperation),
    read: (operationId) => {
      const found = load().operations.find((operation) => operation.operationId === operationId);
      return found ? cloneOperation(found) : undefined;
    },
    activeSummary: () =>
      summary(
        [...load().operations]
          .reverse()
          .find((operation) => operation.state === "queued" || operation.state === "running"),
      ),
    lastSummary: () => summary(load().operations.at(-1)),
    createQueued: (input) =>
      mutate((file) => {
        const existing = file.operations.find(
          (operation) => operation.operationId === input.operationId,
        );
        if (existing) return cloneOperation(existing);
        const active = [...file.operations]
          .reverse()
          .find((operation) => operation.state === "queued" || operation.state === "running");
        if (active) throw new DeployOperationStoreError("operation_active", active.operationId);
        const operation = PersistedDeployOperation.parse({
          ...input,
          state: "queued",
          auditState: input.auditState ?? "recorded",
          outcomes: [],
          recoveryPendingActions: [],
        });
        write({
          ...file,
          revision: file.revision + 1,
          operations: [...file.operations, operation],
        });
        return cloneOperation(operation);
      }),
    markRunning: (operationId) =>
      replace(operationId, (operation) => {
        if (operation.state === "running") return operation;
        if (operation.state !== "queued") {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        if (operation.auditState !== "recorded") {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        return { ...operation, state: "running" };
      }),
    recordOutcomes: (operationId, outcomes) =>
      replace(operationId, (operation) => {
        if (operation.state !== "running") {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        const byAction = new Map(operation.outcomes.map((outcome) => [actionId(outcome), outcome]));
        for (const outcome of outcomes) {
          const parsed = DeployOperationOutcomeSchema.parse(outcome);
          byAction.set(actionId(parsed), parsed);
        }
        return { ...operation, outcomes: [...byAction.values()] };
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
        return { ...operation, state: "failed", completedAt: now(), errorCode };
      }),
    finish: (operationId, state, errorCode) =>
      replace(operationId, (operation) => {
        if (operation.state === state) return operation;
        if (operation.state !== "running") {
          throw new DeployOperationStoreError("operation_invalid_transition", operationId);
        }
        return {
          ...operation,
          state,
          completedAt: now(),
          ...(errorCode ? { errorCode } : {}),
        };
      }),
  };
}
