// Shared test helpers for the Kit module suite.
//
// - redirected temp homes (so the real ~/.claude is never touched)
// - in-memory ustar tar + gzip fixture builder (content-derived top folder)

import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

const HIVE_ENV_KEYS = [
  "HIVE_RUNTIME_ROOT",
  "HIVE_CLAUDE_HOME",
  "HIVE_CODEX_HOME",
  "HIVE_AGENTS_HOME",
  "HIVE_LEDGER_PATH",
] as const;

export type RedirectedHome = {
  root: string;
  claudeHome: string;
  codexHome: string;
  agentsHome: string;
  ledgerPath: string;
  runtimeRoot: string;
};

// Point every HIVE_* env at subdirs of `root` BEFORE defaultDeployTargets() is
// called (the port reads env at call time). Returns the resolved paths.
export function redirectHomeEnv(root: string): RedirectedHome {
  const claudeHome = `${root}/claude`;
  const codexHome = `${root}/codex`;
  const agentsHome = `${root}/agents`;
  const ledgerPath = `${root}/ledger/manifest.json`;
  const runtimeRoot = `${root}/runtime`;
  process.env.HIVE_RUNTIME_ROOT = runtimeRoot;
  process.env.HIVE_CLAUDE_HOME = claudeHome;
  process.env.HIVE_CODEX_HOME = codexHome;
  process.env.HIVE_AGENTS_HOME = agentsHome;
  process.env.HIVE_LEDGER_PATH = ledgerPath;
  return { root, claudeHome, codexHome, agentsHome, ledgerPath, runtimeRoot };
}

// Clear all HIVE_* + skip-env overrides so the real home is never touched and
// state never bleeds between tests.
export function clearHomeEnv(): void {
  for (const k of HIVE_ENV_KEYS) delete process.env[k];
  delete process.env.AGENT_KIT_SKIP_PLUGIN_INSTALL;
  delete process.env.AGENT_KIT_SKIP_BUNDLE_INSTALL;
}

// ---- in-memory ustar tar builder ----

const BLOCK = 512;

export type TarFixtureEntry = {
  // POSIX path relative to (and including) the top folder, e.g.
  // "renamed-top/capabilities/skills/foo/SKILL.md".
  path: string;
  content?: string; // omit/undefined -> directory entry
};

function writeStr(buf: Uint8Array, offset: number, str: string, length: number): void {
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < length; i++) buf[offset + i] = i < bytes.length ? (bytes[i] ?? 0) : 0;
}

function writeOctal(buf: Uint8Array, offset: number, value: number, length: number): void {
  // ustar numeric fields: zero-padded octal, NUL-terminated.
  const s = value.toString(8).padStart(length - 1, "0");
  writeStr(buf, offset, s, length - 1);
  buf[offset + length - 1] = 0;
}

function header(path: string, size: number, isDir: boolean): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeStr(h, 0, path, 100);
  writeOctal(h, 100, isDir ? 0o755 : 0o644, 8); // mode
  writeOctal(h, 108, 0, 8); // uid
  writeOctal(h, 116, 0, 8); // gid
  writeOctal(h, 124, size, 12); // size
  writeOctal(h, 136, 0, 12); // mtime
  h[156] = (isDir ? "5" : "0").charCodeAt(0); // typeflag
  writeStr(h, 257, "ustar", 6); // magic
  writeStr(h, 263, "00", 2); // version
  // checksum: spaces during compute, then octal.
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i] ?? 0;
  writeStr(h, 148, sum.toString(8).padStart(6, "0"), 6);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

// Build a raw (uncompressed) ustar archive from entries.
export function buildTar(entries: TarFixtureEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    const isDir = e.content === undefined;
    const data = isDir ? new Uint8Array(0) : new TextEncoder().encode(e.content);
    const path = isDir && !e.path.endsWith("/") ? `${e.path}/` : e.path;
    chunks.push(header(path, data.length, isDir));
    if (!isDir && data.length > 0) {
      const padded = Math.ceil(data.length / BLOCK) * BLOCK;
      const block = new Uint8Array(padded);
      block.set(data);
      chunks.push(block);
    }
  }
  // Two zero blocks mark end-of-archive.
  chunks.push(new Uint8Array(BLOCK * 2));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Build a gzip'd ustar archive (what codeload serves).
export function buildGzipTar(entries: TarFixtureEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(buildTar(entries))));
}
