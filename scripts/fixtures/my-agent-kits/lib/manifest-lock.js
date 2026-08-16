import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const MANIFEST_LOCK_DEFAULTS = Object.freeze({
  timeoutMs: 5_000,
  staleMs: 2_000,
  updateMs: 500,
});

const LOCK_PROTOCOL = "agent-manifest-lock-v3";
const RETIREMENT_PROTOCOL = "agent-manifest-lock-retirement-v1";
const OWNER_FILE = "owner.json";

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

function wait(ms) {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, Math.max(1, ms));
}

function processSnapshot(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!error || error.code !== "EPERM") return null;
  }
  if (process.platform !== "linux") return { pid, start: null };
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    return { pid, start: fields[19] ?? null };
  } catch {
    return null;
  }
}

function sameProcess(identity) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return false;
  const current = processSnapshot(identity.pid);
  return current !== null &&
    (identity.start === null || current.start === null || current.start === identity.start);
}

function readOwner(lockPath) {
  try {
    const value = JSON.parse(readFileSync(join(lockPath, OWNER_FILE), "utf8"));
    if (
      value.protocol !== LOCK_PROTOCOL ||
      typeof value.token !== "string" ||
      !value.owner ||
      !value.keeper
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function owns(lockPath, token) {
  return readOwner(lockPath)?.token === token;
}

// A remover publishes its unique fence before validating lockPath. A contender
// may reserve lockPath while fenced, but cannot enter work until every live
// remover finishes; cleanup never targets a path another fence can reuse.
function withRetirementFence(lockPath, work) {
  const fence = `${lockPath}.retiring-${randomUUID()}`;
  const temporaryFence = `${fence}.tmp-${randomUUID()}`;
  const actor = processSnapshot(process.pid) ?? { pid: process.pid, start: null };
  try {
    writeFileSync(
      temporaryFence,
      `${JSON.stringify({ protocol: RETIREMENT_PROTOCOL, actor })}\n`,
    );
    renameSync(temporaryFence, fence);
    return work();
  } finally {
    rmSync(temporaryFence, { force: true });
    rmSync(fence, { force: true });
  }
}

function readRetirementFence(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value.protocol !== RETIREMENT_PROTOCOL ||
      !value.actor ||
      !Number.isInteger(value.actor.pid) ||
      value.actor.pid <= 0 ||
      (value.actor.start !== null && typeof value.actor.start !== "string")
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function retirementFencesActive(lockPath, staleMs) {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.retiring-`;
  let entries;
  try {
    entries = readdirSync(directory).filter(
      (entry) => entry.startsWith(prefix) && !entry.includes(".tmp-"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  let active = false;
  for (const entry of entries) {
    const path = join(directory, entry);
    const fence = readRetirementFence(path);
    if (fence) {
      if (sameProcess(fence.actor)) {
        active = true;
      } else {
        rmSync(path, { force: true });
      }
      continue;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs < staleMs) {
        active = true;
      } else {
        rmSync(path, { force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return active;
}

function retireOwnedLock(lockPath, token, suffix) {
  return withRetirementFence(lockPath, () => {
    if (!owns(lockPath, token)) return false;
    const retired = `${lockPath}.${suffix}-${token}`;
    try {
      renameSync(lockPath, retired);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EEXIST") return false;
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
    return true;
  });
}

function recoverAbandonedLock(lockPath, staleMs) {
  let age;
  try {
    age = Date.now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  if (age < staleMs) return false;
  return withRetirementFence(lockPath, () => {
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
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
      if (error?.code === "ENOENT" || error?.code === "EEXIST") return true;
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
    return true;
  });
}

function lockTimeoutError(resourcePath) {
  const error = new Error(`Timed out acquiring manifest lock for ${resourcePath}`);
  error.code = "ELOCKED";
  return error;
}

function acquireManifestLock(resourcePath, options) {
  const timeoutMs = options.timeoutMs ?? MANIFEST_LOCK_DEFAULTS.timeoutMs;
  const staleMs = options.staleMs ?? MANIFEST_LOCK_DEFAULTS.staleMs;
  const updateMs = options.updateMs ?? MANIFEST_LOCK_DEFAULTS.updateMs;
  const lockPath = `${resourcePath}.lock`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  mkdirSync(dirname(resourcePath), { recursive: true });

  while (true) {
    if (retirementFencesActive(lockPath, staleMs)) {
      if (Date.now() >= deadline) throw lockTimeoutError(resourcePath);
      wait(Math.min(10, deadline - Date.now()));
      continue;
    }
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      recoverAbandonedLock(lockPath, staleMs);
      if (Date.now() >= deadline) throw lockTimeoutError(resourcePath);
      wait(Math.min(25, deadline - Date.now()));
      continue;
    }

    const token = randomUUID();
    const owner = processSnapshot(process.pid) ?? { pid: process.pid, start: null };
    const keeper = spawn(process.execPath, ["-e", KEEPER_SOURCE], {
      env: {
        ...process.env,
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
    const metadata = {
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

    const initializationDeadline = Math.min(
      deadline,
      Date.now() + Math.max(2_000, updateMs * 4),
    );
    while (Date.now() < initializationDeadline) {
      try {
        if (readFileSync(readyPath, "utf8") === token) {
          while (retirementFencesActive(lockPath, staleMs)) {
            if (!owns(lockPath, token)) break;
            if (Date.now() >= deadline) {
              retireOwnedLock(lockPath, token, "retired");
              throw lockTimeoutError(resourcePath);
            }
            wait(Math.min(10, deadline - Date.now()));
          }
          if (!owns(lockPath, token)) {
            keeper.kill();
            break;
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            if (!owns(lockPath, token)) return;
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
          };
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!sameProcess(keeperIdentity)) break;
      wait(10);
    }

    if (sameProcess(keeperIdentity)) keeper.kill("SIGKILL");
    retireOwnedLock(lockPath, token, "retired");
    if (Date.now() >= deadline) throw lockTimeoutError(resourcePath);
  }
}

export async function withIndependentManifestLock(resourcePath, work, options = {}) {
  const release = acquireManifestLock(resourcePath, options);
  try {
    return await work();
  } finally {
    release();
  }
}
