import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { files } from "../lib/paths.ts";

export const DAEMON_PROTOCOL_VERSION = 1 as const;
export const HIVE_BUILD_VERSION = process.env.HIVE_BUILD_VERSION?.trim() || "0.0.0";

export function runtimeRootId(mode: "file" | "memory"): string {
  if (mode === "memory") return crypto.randomUUID();
  const path = files.runtimeId();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const id = crypto.randomUUID();
  writeFileSync(path, id, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement Unix permission bits.
  }
  return id;
}
