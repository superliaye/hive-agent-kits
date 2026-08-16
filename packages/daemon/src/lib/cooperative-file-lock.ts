import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export const COOPERATIVE_FILE_LOCK_DEFAULTS = {
  timeoutMs: 5_000,
  staleMs: 2_000,
  updateMs: 500,
} as const;

const LOCK_PROTOCOL = "agent-manifest-lock-v3";
const RETIREMENT_PROTOCOL = "agent-manifest-lock-retirement-v1";
const OWNER_FILE = "owner.json";

const ProcessIdentity = z.object({
  pid: z.number().int().positive(),
  start: z.string().nullable(),
});

const RetirementFence = z.object({
  protocol: z.literal(RETIREMENT_PROTOCOL),
  actor: ProcessIdentity,
});

const LockOwner = z.object({
  protocol: z.literal(LOCK_PROTOCOL),
  token: z.string(),
  owner: ProcessIdentity,
  keeper: ProcessIdentity,
  staleMs: z.number().nonnegative(),
  updateMs: z.number().positive(),
});
type LockOwner = z.infer<typeof LockOwner>;
type ProcessIdentity = z.infer<typeof ProcessIdentity>;

export type IndependentFileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  updateMs?: number;
};

const KEEPER_SOURCE = String.raw`
const {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const lockPath = process.env.AGENT_MANIFEST_LOCK_PATH;
const token = process.env.AGENT_MANIFEST_LOCK_TOKEN;
const protocol = process.env.AGENT_MANIFEST_LOCK_PROTOCOL;
const retirementProtocol = process.env.AGENT_MANIFEST_RETIREMENT_PROTOCOL;
const ownerPid = Number(process.env.AGENT_MANIFEST_LOCK_OWNER_PID);
const ownerStart = process.env.AGENT_MANIFEST_LOCK_OWNER_START || null;
const updateMs = Number(process.env.AGENT_MANIFEST_LOCK_UPDATE_MS);
const readyPath = join(lockPath, "ready-" + token);
const releasePath = join(lockPath, "release-" + token);
const initializedBy = Date.now() + 2000;
let ready = false;
let nextHeartbeat = 0;

function snapshot(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!error || error.code !== "EPERM") return null;
  }
  if (process.platform !== "linux") return { start: null };
  try {
    const value = readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    return { start: fields[19] || null };
  } catch {
    return null;
  }
}

function sameProcess(pid, start) {
  const current = snapshot(pid);
  return current !== null && (start === null || current.start === null || current.start === start);
}

function owner() {
  try {
    const value = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    if (
      value.protocol !== protocol ||
      value.token !== token ||
      value.owner.pid !== ownerPid ||
      value.keeper.pid !== process.pid
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function retire() {
  const fence = lockPath + ".retiring-" + require("node:crypto").randomUUID();
  const temporaryFence = fence + ".tmp-" + require("node:crypto").randomUUID();
  const actor = snapshot(process.pid);
  try {
    writeFileSync(temporaryFence, JSON.stringify({
      protocol: retirementProtocol,
      actor: { pid: process.pid, start: actor && actor.start || null },
    }) + "\n");
    renameSync(temporaryFence, fence);
    if (!owner()) return;
    const retired = lockPath + ".retired-" + token;
    try {
      renameSync(lockPath, retired);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "EEXIST")) return;
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
  } finally {
    rmSync(temporaryFence, { force: true });
    rmSync(fence, { force: true });
  }
}

function finish() {
  try {
    retire();
  } finally {
    process.exit(0);
  }
}

function tick() {
  const current = owner();
  if (!current) {
    if (!sameProcess(ownerPid, ownerStart) || Date.now() >= initializedBy) process.exit(0);
    setTimeout(tick, 25);
    return;
  }
  if (existsSync(releasePath) || !sameProcess(current.owner.pid, current.owner.start)) {
    finish();
    return;
  }
  const now = Date.now();
  try {
    if (now >= nextHeartbeat) {
      const heartbeat = new Date(now);
      utimesSync(lockPath, heartbeat, heartbeat);
      nextHeartbeat = now + updateMs;
    }
    if (!ready) {
      writeFileSync(readyPath, token);
      ready = true;
    }
  } catch {
    process.exit(0);
  }
  setTimeout(tick, 25);
}

tick();
`;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function wait(ms: number): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, Math.max(1, ms));
}

function processSnapshot(pid: number): ProcessIdentity | null {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errorCode(error) !== "EPERM") return null;
  }
  if (process.platform !== "linux") return { pid, start: null };
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value
      .slice(value.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === "Z") return null;
    return { pid, start: fields[19] ?? null };
  } catch {
    return null;
  }
}

function sameProcess(identity: ProcessIdentity | null | undefined): boolean {
  if (!identity) return false;
  const current = processSnapshot(identity.pid);
  return (
    current !== null &&
    (identity.start === null || current.start === null || current.start === identity.start)
  );
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    return LockOwner.parse(JSON.parse(readFileSync(join(lockPath, OWNER_FILE), "utf8")));
  } catch {
    return null;
  }
}

function owns(lockPath: string, token: string): boolean {
  return readOwner(lockPath)?.token === token;
}

// A remover publishes its unique fence before validating lockPath. A contender
// may reserve lockPath while fenced, but cannot enter work until every live
// remover finishes; cleanup never targets a path another fence can reuse.
function withRetirementFence<A>(lockPath: string, work: () => A): A {
  const fence = `${lockPath}.retiring-${randomUUID()}`;
  const temporaryFence = `${fence}.tmp-${randomUUID()}`;
  const actor = processSnapshot(process.pid) ?? { pid: process.pid, start: null };
  try {
    writeFileSync(temporaryFence, `${JSON.stringify({ protocol: RETIREMENT_PROTOCOL, actor })}\n`);
    renameSync(temporaryFence, fence);
    return work();
  } finally {
    rmSync(temporaryFence, { force: true });
    rmSync(fence, { force: true });
  }
}

function retirementFencesActive(lockPath: string, staleMs: number): boolean {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.retiring-`;
  let entries: string[];
  try {
    entries = readdirSync(directory).filter(
      (entry) => entry.startsWith(prefix) && !entry.includes(".tmp-"),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }

  let active = false;
  for (const entry of entries) {
    const path = join(directory, entry);
    try {
      const fence = RetirementFence.parse(JSON.parse(readFileSync(path, "utf8")));
      if (sameProcess(fence.actor)) {
        active = true;
      } else {
        rmSync(path, { force: true });
      }
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs < staleMs) {
          active = true;
        } else {
          rmSync(path, { force: true });
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
  return active;
}

function retireOwnedLock(lockPath: string, token: string, suffix: string): boolean {
  return withRetirementFence(lockPath, () => {
    if (!owns(lockPath, token)) return false;
    const retired = `${lockPath}.${suffix}-${token}`;
    try {
      renameSync(lockPath, retired);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "EEXIST") return false;
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
    return true;
  });
}

function recoverAbandonedLock(lockPath: string, staleMs: number): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  if (age < staleMs) return false;
  return withRetirementFence(lockPath, () => {
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    if (age < staleMs) return false;
    const current = readOwner(lockPath);
    if (current && (sameProcess(current.owner) || sameProcess(current.keeper))) return false;
    const token = current?.token ?? randomUUID();
    const retired = `${lockPath}.abandoned-${token}-${randomUUID()}`;
    try {
      renameSync(lockPath, retired);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "EEXIST") return true;
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
    return true;
  });
}

function lockTimeoutError(resourcePath: string): Error {
  const error = new Error(`Timed out acquiring manifest lock for ${resourcePath}`);
  (error as NodeJS.ErrnoException).code = "ELOCKED";
  return error;
}

function* independentFileLockAcquisition(
  resourcePath: string,
  options: IndependentFileLockOptions,
): Generator<number, () => void, void> {
  const timeoutMs = options.timeoutMs ?? COOPERATIVE_FILE_LOCK_DEFAULTS.timeoutMs;
  const staleMs = options.staleMs ?? COOPERATIVE_FILE_LOCK_DEFAULTS.staleMs;
  const updateMs = options.updateMs ?? COOPERATIVE_FILE_LOCK_DEFAULTS.updateMs;
  const lockPath = `${resourcePath}.lock`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  mkdirSync(dirname(resourcePath), { recursive: true });

  while (true) {
    if (retirementFencesActive(lockPath, staleMs)) {
      if (Date.now() >= deadline) throw lockTimeoutError(resourcePath);
      yield Math.min(10, deadline - Date.now());
      continue;
    }
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      recoverAbandonedLock(lockPath, staleMs);
      if (Date.now() >= deadline) throw lockTimeoutError(resourcePath);
      yield Math.min(25, deadline - Date.now());
      continue;
    }

    const token = randomUUID();
    const owner = processSnapshot(process.pid) ?? { pid: process.pid, start: null };
    const keeper = spawn(process.execPath, ["-e", KEEPER_SOURCE], {
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
        AGENT_MANIFEST_LOCK_PATH: lockPath,
        AGENT_MANIFEST_LOCK_TOKEN: token,
        AGENT_MANIFEST_LOCK_PROTOCOL: LOCK_PROTOCOL,
        AGENT_MANIFEST_RETIREMENT_PROTOCOL: RETIREMENT_PROTOCOL,
        AGENT_MANIFEST_LOCK_OWNER_PID: String(owner.pid),
        AGENT_MANIFEST_LOCK_OWNER_START: owner.start ?? "",
        AGENT_MANIFEST_LOCK_UPDATE_MS: String(updateMs),
      },
      stdio: "ignore",
    });
    keeper.unref();
    if (keeper.pid === undefined) {
      rmSync(lockPath, { recursive: true, force: true });
      throw new Error("manifest lock keeper failed to start");
    }
    const keeperIdentity = processSnapshot(keeper.pid) ?? { pid: keeper.pid, start: null };
    const metadata: LockOwner = {
      protocol: LOCK_PROTOCOL,
      token,
      owner,
      keeper: keeperIdentity,
      staleMs,
      updateMs,
    };
    const temporaryOwner = join(lockPath, `.owner-${token}.tmp`);
    writeFileSync(temporaryOwner, `${JSON.stringify(metadata)}\n`);
    renameSync(temporaryOwner, join(lockPath, OWNER_FILE));
    const readyPath = join(lockPath, `ready-${token}`);

    const initializationDeadline = Math.min(deadline, Date.now() + Math.max(2_000, updateMs * 4));
    while (Date.now() < initializationDeadline) {
      try {
        if (readFileSync(readyPath, "utf8") === token) {
          while (retirementFencesActive(lockPath, staleMs)) {
            if (!owns(lockPath, token)) break;
            if (Date.now() >= deadline) {
              retireOwnedLock(lockPath, token, "retired");
              throw lockTimeoutError(resourcePath);
            }
            yield Math.min(10, deadline - Date.now());
          }
          if (!owns(lockPath, token)) {
            keeper.kill();
            break;
          }
          let released = false;
          return () => {
            if (released) return;
            if (!owns(lockPath, token)) {
              released = true;
              return;
            }
            let releaseError: unknown;
            try {
              writeFileSync(join(lockPath, `release-${token}`), token);
              const releaseDeadline = Date.now() + Math.max(timeoutMs, staleMs + updateMs);
              while (owns(lockPath, token)) {
                if (!sameProcess(keeperIdentity)) {
                  retireOwnedLock(lockPath, token, "retired");
                  break;
                }
                if (Date.now() >= releaseDeadline) {
                  throw new Error(`Timed out releasing manifest lock for ${resourcePath}`);
                }
                wait(10);
              }
            } catch (error) {
              releaseError = error;
            } finally {
              if (owns(lockPath, token)) {
                try {
                  if (sameProcess(keeperIdentity)) keeper.kill("SIGKILL");
                  retireOwnedLock(lockPath, token, "retired");
                } catch (cleanupError) {
                  releaseError ??= cleanupError;
                }
              }
              released = !owns(lockPath, token);
            }
            if (releaseError) throw releaseError;
          };
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (!sameProcess(keeperIdentity)) break;
      yield 10;
    }

    if (sameProcess(keeperIdentity)) keeper.kill("SIGKILL");
    retireOwnedLock(lockPath, token, "retired");
    if (Date.now() >= deadline) throw lockTimeoutError(resourcePath);
  }
}

function acquireIndependentFileLock(
  resourcePath: string,
  options: IndependentFileLockOptions,
): () => void {
  const acquisition = independentFileLockAcquisition(resourcePath, options);
  while (true) {
    const step = acquisition.next();
    if (step.done === true) return step.value;
    wait(step.value);
  }
}

async function acquireIndependentFileLockAsync(
  resourcePath: string,
  options: IndependentFileLockOptions,
): Promise<() => void> {
  const acquisition = independentFileLockAcquisition(resourcePath, options);
  while (true) {
    const step = acquisition.next();
    if (step.done === true) return step.value;
    await new Promise<void>((resolve) => setTimeout(resolve, step.value));
  }
}

export function withIndependentFileLock<A>(
  resourcePath: string,
  work: () => A,
  options: IndependentFileLockOptions = {},
): A {
  const release = acquireIndependentFileLock(resourcePath, options);
  try {
    return work();
  } finally {
    release();
  }
}

export async function withIndependentFileLockAsync<A>(
  resourcePath: string,
  work: () => Promise<A>,
  options: IndependentFileLockOptions = {},
): Promise<A> {
  const release = await acquireIndependentFileLockAsync(resourcePath, options);
  try {
    return await work();
  } finally {
    release();
  }
}
