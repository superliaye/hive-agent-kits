import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export type AtomicWriteOptions = {
  rename?: (oldPath: string, newPath: string) => void;
  fsyncDirectory?: (directory: string) => void;
  write?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
};

export type CooperativeFileLockOptions = {
  staleMs?: number;
  updateMs?: number;
};

export function withCooperativeFileLock<A>(
  resourcePath: string,
  timeoutMs: number,
  work: () => A,
  options: CooperativeFileLockOptions = {},
): A {
  mkdirSync(dirname(resourcePath), { recursive: true });
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let release: (() => void) | undefined;
  while (!release) {
    try {
      release = lockfile.lockSync(resourcePath, {
        realpath: false,
        stale: options.staleMs ?? 10_000,
        update: options.updateMs ?? 2_000,
        retries: 0,
      });
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ELOCKED" || Date.now() >= deadline) throw error;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
  try {
    return work();
  } finally {
    release();
  }
}

export function withAdvisoryFileLock<A>(resourcePath: string, timeoutMs: number, work: () => A): A {
  const directory = dirname(resourcePath);
  mkdirSync(directory, { recursive: true });
  const database = new Database(`${resourcePath}.lock.sqlite`, { create: true });
  let began = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
    database.exec("CREATE TABLE IF NOT EXISTS durable_file_lock (id INTEGER PRIMARY KEY)");
    database.exec("BEGIN IMMEDIATE");
    began = true;
    const value = work();
    database.exec("COMMIT");
    began = false;
    return value;
  } finally {
    if (began) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original lock-holder failure remains authoritative.
      }
    }
    database.close();
  }
}

export function atomicWriteFile(
  path: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const directory = dirname(path);
  const rename = options.rename ?? renameSync;
  const writeBytes =
    options.write ??
    ((fd: number, value: Uint8Array, offset: number, length: number) =>
      writeSync(fd, value, offset, length));
  const fsyncDirectory =
    options.fsyncDirectory ??
    ((target: string) => {
      const fd = openSync(target, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let renamed = false;
  try {
    const fd = openSync(temporary, "w", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeBytes(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
          throw new Error("durable write made no progress");
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
    if (!renamed && existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the primary write failure.
      }
    }
  }
}
