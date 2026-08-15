import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
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

export const DeploymentApplied = z.object({
  sourceId: z.string().nullable(),
  contentSha: z.string().nullable(),
  renderedHash: z.string(),
  appliedAt: z.number().int().nonnegative(),
});
export type DeploymentApplied = z.infer<typeof DeploymentApplied>;

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
  staleLockMs?: number;
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
  return { schemaVersion: 1, revision: 0, records: [], legacyInstructionFingerprints: [] };
}

function recordId(
  key: z.infer<typeof CapabilityKey>,
  target: z.infer<typeof DeployTarget>,
): string {
  return `${serializeCapabilityKey(key)}\u0000${target}`;
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
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,;]+[\\/])*[^\s,;]*/g, "<redacted-path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

function normalizeCode(code: string): z.infer<typeof FailureCode> {
  const parsed = FailureCode.safeParse(code);
  return parsed.success ? parsed.data : "unknown";
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
  const staleLockMs = options.staleLockMs ?? 30_000;
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

  const load = (): DeploymentStateFile | undefined => {
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("deployment_state_corrupt");
    }
    const parsed = DeploymentStateFile.safeParse(raw);
    if (parsed.success) return parsed.data;
    throw new Error("deployment_state_corrupt");
  };

  const write = (file: DeploymentStateFile): void => {
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
      throw new Error("deployment_state_write_failed");
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
    mkdirSync(directory, { recursive: true });
    const deadline = Date.now() + lockTimeoutMs;
    let lockFd: number | undefined;
    while (lockFd === undefined) {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== "EEXIST") throw new Error("deployment_state_lock_failed");
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > staleLockMs) {
            unlinkSync(lockPath);
            fsyncDirectory(directory);
            continue;
          }
        } catch (staleError) {
          const staleCode =
            staleError instanceof Error ? (staleError as NodeJS.ErrnoException).code : undefined;
          if (staleCode !== "ENOENT") throw new Error("deployment_state_lock_failed");
        }
        if (Date.now() >= deadline) throw new Error("deployment_state_lock_timeout");
        waitForLock();
      }
    }
    try {
      return work();
    } finally {
      closeSync(lockFd);
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

  const current = (): DeploymentStateFile => {
    const loaded = load();
    if (loaded) return loaded;
    return withLock(() => load() ?? migrate());
  };

  const commit = (
    keyInput: z.input<typeof CapabilityKey>,
    targetInput: z.input<typeof DeployTarget>,
    change: (previous: DeploymentStateRecord | undefined) => DeploymentStateRecord,
  ): DeploymentStateRecord => {
    const key = CapabilityKey.parse(keyInput);
    const target = DeployTarget.parse(targetInput);
    return withLock(() => {
      const file = load() ?? migrate();
      const id = recordId(key, target);
      const previous = file.records.find((record) => recordId(record.key, record.target) === id);
      const nextRecord = DeploymentStateRecord.parse(change(previous));
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
        applied: DeploymentApplied.parse(applied),
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
    markInterrupted: (key, target, action, operationId) =>
      commit(key, target, (previous) => ({
        key: CapabilityKey.parse(key),
        target: DeployTarget.parse(target),
        ...(previous?.applied ? { applied: previous.applied } : {}),
        lastAttempt: {
          action: AttemptAction.parse(action),
          outcome: "interrupted",
          attemptedAt: now(),
          operationId,
        },
      })),
  };
}
