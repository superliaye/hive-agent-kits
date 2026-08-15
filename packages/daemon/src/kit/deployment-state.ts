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
import { DeployTarget } from "@hive/contract";
import { z } from "zod";
import { readFingerprintSidecar } from "./fingerprint.ts";

const AttemptAction = z.enum(["add", "update", "remove"]);
const AttemptOutcome = z.enum(["succeeded", "failed", "interrupted"]);
const FailureCode = z.enum(["io", "source_missing", "installer_failed", "unknown"]);

export class DeploymentStateError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DeploymentStateError";
    this.code = code;
  }
}

export const DeploymentApplied = z.object({
  sourceId: z.string().nullable(),
  contentSha: z.string().nullable(),
  renderedHash: z.string(),
  appliedAt: z.number().int().nonnegative(),
  operationId: z.string().min(1).default("legacy-deployment-import"),
});
export type DeploymentApplied = z.input<typeof DeploymentApplied>;

export const DeploymentAttempt = z.object({
  action: AttemptAction,
  outcome: AttemptOutcome,
  attemptedAt: z.number().int().nonnegative(),
  operationId: z.string(),
  code: FailureCode.optional(),
  detail: z.string().max(512).optional(),
});

export const DeploymentStateRecord = z.object({
  key: CapabilityKey,
  target: DeployTarget,
  applied: DeploymentApplied.optional(),
  lastAttempt: DeploymentAttempt,
});
export type DeploymentStateRecord = z.infer<typeof DeploymentStateRecord>;

const DeploymentInterruptionReceipt = z.object({
  key: CapabilityKey,
  target: DeployTarget,
  action: AttemptAction,
  operationId: z.string(),
});

const LegacyInstructionFingerprint = z.object({
  target: DeployTarget,
  renderedHash: z.string(),
  appliedAt: z.number().int().nonnegative(),
});

export const DeploymentStateFile = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  records: z.array(DeploymentStateRecord),
  legacyInstructionFingerprints: z.array(LegacyInstructionFingerprint).default([]),
  interruptionReceipts: z.array(DeploymentInterruptionReceipt).optional(),
});
export type DeploymentStateFile = z.infer<typeof DeploymentStateFile>;

type FailureInput = {
  action: z.infer<typeof AttemptAction>;
  code: string;
  detail: string;
};

export type DeploymentStateStoreOptions = {
  legacyFingerprintPath?: string;
  now?: () => number;
  rename?: (oldPath: string, newPath: string) => void;
  fsyncDirectory?: (directory: string) => void;
  write?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
  lockTimeoutMs?: number;
  close?: (fd: number) => void;
  lockWrite?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
};

export type DeploymentStateStore = {
  read(
    key: z.input<typeof CapabilityKey>,
    target: z.input<typeof DeployTarget>,
  ): DeploymentStateRecord | undefined;
  readAll(): DeploymentStateFile;
  recordSuccess(
    key: z.input<typeof CapabilityKey>,
    target: z.input<typeof DeployTarget>,
    applied: DeploymentApplied,
    operationId: string,
  ): DeploymentStateRecord;
  recordFailure(
    key: z.input<typeof CapabilityKey>,
    target: z.input<typeof DeployTarget>,
    failure: FailureInput,
    operationId: string,
  ): DeploymentStateRecord;
  recordRemoval(
    key: z.input<typeof CapabilityKey>,
    target: z.input<typeof DeployTarget>,
    operationId: string,
  ): DeploymentStateRecord;
  markInterrupted(
    key: z.input<typeof CapabilityKey>,
    target: z.input<typeof DeployTarget>,
    action: z.infer<typeof AttemptAction>,
    operationId: string,
  ): DeploymentStateRecord;
};

function emptyFile(): DeploymentStateFile {
  return {
    schemaVersion: 1,
    revision: 0,
    records: [],
    legacyInstructionFingerprints: [],
    interruptionReceipts: [],
  };
}

function recordId(
  key: z.infer<typeof CapabilityKey>,
  target: z.infer<typeof DeployTarget>,
): string {
  return `${serializeCapabilityKey(key)}\u0000${target}`;
}

function interruptionReceiptId(receipt: z.infer<typeof DeploymentInterruptionReceipt>): string {
  return `${recordId(receipt.key, receipt.target)}\u0000${receipt.action}\u0000${receipt.operationId}`;
}

function redactDetail(detail: string): string {
  return detail
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, "authorization=<redacted>")
    .replace(/\bbearer\s+[^\s,;]+/gi, "bearer <redacted>")
    .replace(
      /\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=<redacted>",
    )
    .replace(/(?:https?|ssh):\/\/[^\s,;]+/gi, "<redacted-url>")
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, "<redacted-path>")
    .replace(
      /\\\\[^\\/:*?"<>|\r\n]+\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g,
      "<redacted-path>",
    )
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,;]+[\\/])*[^\s,;]*/g, "<redacted-path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

function normalizeCode(code: string): z.infer<typeof FailureCode> {
  const parsed = FailureCode.safeParse(code);
  return parsed.success ? parsed.data : "unknown";
}

function appliedOperationIdMissing(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const applied = Reflect.get(value, "applied");
  return (
    applied !== undefined &&
    applied !== null &&
    typeof applied === "object" &&
    !Object.hasOwn(applied, "operationId")
  );
}

function readLegacyFingerprint(
  path: string,
): Pick<DeploymentStateFile, "records" | "legacyInstructionFingerprints"> {
  const records = new Map<string, DeploymentStateRecord>();
  const legacyInstructionFingerprints: z.infer<typeof LegacyInstructionFingerprint>[] = [];
  for (const entry of readFingerprintSidecar(path).entries) {
    if (entry.kind === "instruction" && entry.name === "") {
      legacyInstructionFingerprints.push({
        target: entry.target,
        renderedHash: entry.hash,
        appliedAt: entry.deployedAt,
      });
      continue;
    }
    const record = DeploymentStateRecord.parse({
      key: { kind: entry.kind, name: entry.name },
      target: entry.target,
      applied: {
        sourceId: entry.winnerSourceId ?? null,
        contentSha: null,
        renderedHash: entry.hash,
        appliedAt: entry.deployedAt,
        operationId: "legacy-fingerprint-import",
      },
      lastAttempt: {
        action: "add",
        outcome: "succeeded",
        attemptedAt: entry.deployedAt,
        operationId: "legacy-fingerprint-import",
      },
    });
    records.set(recordId(record.key, record.target), record);
  }
  return { records: [...records.values()], legacyInstructionFingerprints };
}

export function openDeploymentStateStore(
  path: string,
  options: DeploymentStateStoreOptions = {},
): DeploymentStateStore {
  const now = options.now ?? Date.now;
  const rename = options.rename ?? renameSync;
  const lockPath = `${path}.lock`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  const close = options.close ?? closeSync;
  const lockWrite = options.lockWrite ?? writeSync;
  const writeBytes =
    options.write ??
    ((fd: number, bytes: Uint8Array, offset: number, length: number) =>
      writeSync(fd, bytes, offset, length));
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

  const load = (): { file: DeploymentStateFile; needsMigration: boolean } | undefined => {
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new DeploymentStateError("deployment_state_corrupt");
    }
    const parsed = DeploymentStateFile.safeParse(raw);
    if (parsed.success) {
      const rawRecords =
        raw && typeof raw === "object" && Array.isArray(Reflect.get(raw, "records"))
          ? Reflect.get(raw, "records")
          : [];
      let needsMigration = false;
      const records = parsed.data.records.map((record, index) => {
        if (!record.applied || !appliedOperationIdMissing(rawRecords[index])) return record;
        needsMigration = true;
        const successfulOperationId =
          record.lastAttempt.outcome === "succeeded" && record.lastAttempt.action !== "remove"
            ? record.lastAttempt.operationId
            : "legacy-deployment-import";
        return {
          ...record,
          applied: { ...record.applied, operationId: successfulOperationId },
        };
      });
      return {
        file: needsMigration ? DeploymentStateFile.parse({ ...parsed.data, records }) : parsed.data,
        needsMigration,
      };
    }
    throw new DeploymentStateError("deployment_state_corrupt");
  };

  const write = (file: DeploymentStateFile): void => {
    const directory = dirname(path);
    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let renamed = false;
    try {
      mkdirSync(directory, { recursive: true });
      const fd = openSync(temporary, "w", 0o600);
      try {
        const bytes = Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeBytes(fd, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
            throw new Error("deployment_state_write_failed: write made no progress");
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
    } catch {
      throw new DeploymentStateError("deployment_state_write_failed");
    } finally {
      if (!renamed && existsSync(temporary)) {
        try {
          unlinkSync(temporary);
        } catch {
          // The primary write failure is the only useful semantic outcome.
        }
      }
    }
  };

  const waitForLock = (): void => {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, 10);
  };

  const withLock = <T>(work: () => T): T => {
    const directory = dirname(path);
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      throw new DeploymentStateError("deployment_state_lock_failed");
    }
    const deadline = Date.now() + lockTimeoutMs;
    let lockFd: number | undefined;
    while (lockFd === undefined) {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
        try {
          const bytes = Buffer.from(`${process.pid}\n`);
          let offset = 0;
          while (offset < bytes.length) {
            const written = lockWrite(lockFd, bytes, offset, bytes.length - offset);
            if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
              throw new DeploymentStateError("deployment_state_lock_failed");
            }
            offset += written;
          }
          fsyncSync(lockFd);
        } catch {
          try {
            close(lockFd);
          } catch {
            // Preserve the primary stable owner-write failure.
          }
          try {
            unlinkSync(lockPath);
          } catch {
            // The failed lock is recovered by the next acquisition attempt.
          }
          throw new DeploymentStateError("deployment_state_lock_failed");
        }
      } catch (error) {
        if (error instanceof DeploymentStateError) throw error;
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== "EEXIST") throw new DeploymentStateError("deployment_state_lock_failed");
        if (Date.now() >= deadline) throw new DeploymentStateError("deployment_state_lock_timeout");
        waitForLock();
      }
    }
    try {
      return work();
    } finally {
      try {
        close(lockFd);
      } catch {
        // A failed close cannot expose an OS error through the store API.
      }
      try {
        unlinkSync(lockPath);
        fsyncDirectory(directory);
      } catch {
        // A failed release cannot replace the committed outcome or its error.
      }
    }
  };

  const migrate = (): DeploymentStateFile => {
    const imported = options.legacyFingerprintPath
      ? readLegacyFingerprint(options.legacyFingerprintPath)
      : { records: [], legacyInstructionFingerprints: [] };
    if (imported.records.length === 0 && imported.legacyInstructionFingerprints.length === 0) {
      return emptyFile();
    }
    const initial = DeploymentStateFile.parse({
      schemaVersion: 1,
      revision: 1,
      ...imported,
    });
    write(initial);
    return initial;
  };

  const loadLocked = (): DeploymentStateFile => {
    const loaded = load();
    if (!loaded) return migrate();
    if (loaded.needsMigration) write(loaded.file);
    return loaded.file;
  };

  const current = (): DeploymentStateFile => {
    const loaded = load();
    if (loaded && !loaded.needsMigration) return loaded.file;
    return withLock(loadLocked);
  };

  const commit = (
    keyInput: z.input<typeof CapabilityKey>,
    targetInput: z.input<typeof DeployTarget>,
    change: (previous: DeploymentStateRecord | undefined) => DeploymentStateRecord,
  ): DeploymentStateRecord => {
    const key = CapabilityKey.parse(keyInput);
    const target = DeployTarget.parse(targetInput);
    return withLock(() => {
      const file = loadLocked();
      const id = recordId(key, target);
      const previous = file.records.find((record) => recordId(record.key, record.target) === id);
      const nextRecord = DeploymentStateRecord.parse(change(previous));
      if (previous && JSON.stringify(previous) === JSON.stringify(nextRecord)) return previous;
      const records = file.records.filter((record) => recordId(record.key, record.target) !== id);
      records.push(nextRecord);
      write({ ...file, revision: file.revision + 1, records });
      return nextRecord;
    });
  };

  return {
    read: (keyInput, targetInput) => {
      const key = CapabilityKey.parse(keyInput);
      const target = DeployTarget.parse(targetInput);
      return current().records.find(
        (record) => recordId(record.key, record.target) === recordId(key, target),
      );
    },
    readAll: () => current(),
    recordSuccess: (key, target, applied, operationId) =>
      commit(key, target, (previous) => ({
        key: CapabilityKey.parse(key),
        target: DeployTarget.parse(target),
        applied: DeploymentApplied.parse({ ...applied, operationId }),
        lastAttempt: {
          action: previous?.applied ? "update" : "add",
          outcome: "succeeded",
          attemptedAt: applied.appliedAt,
          operationId,
        },
      })),
    recordFailure: (key, target, failure, operationId) =>
      commit(key, target, (previous) => ({
        key: CapabilityKey.parse(key),
        target: DeployTarget.parse(target),
        ...(previous?.applied ? { applied: previous.applied } : {}),
        lastAttempt: {
          action: AttemptAction.parse(failure.action),
          outcome: "failed",
          attemptedAt: now(),
          operationId,
          code: normalizeCode(failure.code),
          ...(redactDetail(failure.detail) ? { detail: redactDetail(failure.detail) } : {}),
        },
      })),
    recordRemoval: (key, target, operationId) =>
      commit(key, target, () => ({
        key: CapabilityKey.parse(key),
        target: DeployTarget.parse(target),
        lastAttempt: { action: "remove", outcome: "succeeded", attemptedAt: now(), operationId },
      })),
    markInterrupted: (key, target, action, operationId) => {
      const parsedKey = CapabilityKey.parse(key);
      const parsedTarget = DeployTarget.parse(target);
      const parsedAction = AttemptAction.parse(action);
      const receipt = DeploymentInterruptionReceipt.parse({
        key: parsedKey,
        target: parsedTarget,
        action: parsedAction,
        operationId,
      });
      return withLock(() => {
        const file = loadLocked();
        const id = recordId(parsedKey, parsedTarget);
        const previous = file.records.find((record) => recordId(record.key, record.target) === id);
        const receipts = file.interruptionReceipts ?? [];
        const alreadyAccounted = receipts.some(
          (candidate) => interruptionReceiptId(candidate) === interruptionReceiptId(receipt),
        );
        if (alreadyAccounted) {
          if (!previous) throw new DeploymentStateError("deployment_state_corrupt");
          return previous;
        }
        const sameLastAttempt =
          previous?.lastAttempt.outcome === "interrupted" &&
          previous.lastAttempt.operationId === operationId &&
          previous.lastAttempt.action === parsedAction;
        const nextRecord = sameLastAttempt
          ? previous
          : DeploymentStateRecord.parse({
              key: parsedKey,
              target: parsedTarget,
              ...(previous?.applied ? { applied: previous.applied } : {}),
              lastAttempt: {
                action: parsedAction,
                outcome: "interrupted",
                attemptedAt: now(),
                operationId,
              },
            });
        const records = file.records.filter((record) => recordId(record.key, record.target) !== id);
        records.push(nextRecord);
        write({
          ...file,
          revision: file.revision + 1,
          records,
          interruptionReceipts: [...receipts, receipt],
        });
        return nextRecord;
      });
    },
  };
}
