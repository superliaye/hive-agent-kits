// User-data path resolution per ADR-0002 ("User data location").
// All paths derive from one root: ~/.hive/. Single source of truth.

import { homedir } from "node:os";
import { join } from "node:path";

export const HIVE_DIR = join(homedir(), ".hive");
export const HIVE_DB = join(HIVE_DIR, "hive.db");
export const AUDIT_DB = join(HIVE_DIR, "audit.db");
export const AUDIT_ARCHIVE_DIR = join(HIVE_DIR, "audit-archive");
export const CAPABILITIES_DIR = join(HIVE_DIR, "capabilities");
export const AGENTS_DIR = join(HIVE_DIR, "agents");
export const MCP_DIR = join(HIVE_DIR, "mcp");
export const LOGS_DIR = join(HIVE_DIR, "logs");
export const TOKEN_FILE = join(HIVE_DIR, ".token");
export const CONFIG_FILE = join(HIVE_DIR, "config.yaml");
