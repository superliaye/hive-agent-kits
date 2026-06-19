// Deploy fs/exec adapter (Plan A4) — the single narrow I/O boundary for the
// deploy engine. All writes + external execs go through here, against the
// redirected child env from the DeployTargets port. Injectable so a test can
// assert the exec adapter is NOT called under AGENT_KIT_SKIP_*.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DeployError } from "../effect/errors.ts";
import type { DeployTargets } from "../targets.ts";
import type { SkillFile } from "./transforms.ts";

export type ExecResult = { status: number; stdout: string; stderr: string };
export type ExecRequest = { command: string; args: string[]; cwd?: string };

// The exec port — injectable. Production wires `bunExec`; tests inject a mock to
// assert what was/was not run.
export type ExecPort = (req: ExecRequest, env: NodeJS.ProcessEnv) => ExecResult;

// Binary presence check — injectable for the missing-binary test.
export type BinaryProbe = (name: string, env: NodeJS.ProcessEnv) => boolean;

export type DeployFsExec = {
  targets: DeployTargets;
  exec: ExecPort;
  probe: BinaryProbe;
};

// ---- filesystem ----

export function writeSkillFolder(dest: string, files: SkillFile[]): void {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const full = join(dest, f.rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }
}

export function writeFileAt(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function removeDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function removeFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

// Back up an existing instruction file to <file>.hive-bak before the first
// overwrite. NEVER clobbers an existing backup — otherwise the second deploy
// would copy the Kit-generated file over the user's original backup, destroying
// the only recoverable copy. Returns true if a (new) backup was made.
export function backupIfExists(path: string): boolean {
  if (!existsSync(path)) return false;
  const backup = `${path}.hive-bak`;
  if (existsSync(backup)) return false;
  cpSync(path, backup);
  return true;
}

// Read a skill source folder from the Mirror into SkillFile[] (recursive), so
// the pure transform can filter/expand without touching disk itself.
export function readSkillSource(srcDir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        out.push({
          rel: relative(srcDir, full).replace(/\\/g, "/"),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  if (existsSync(srcDir)) walk(srcDir);
  return out;
}

// ---- exec, with the A0 redirection guard ----

// Run an external installer through the resolved child env. In production this
// legitimately targets the real home (deploying is the product's whole point).
// The A0 blast-radius guard exists only to stop HIVE'S OWN TEST SUITE from
// shelling out a real installer against the developer's real ~/.claude: it fires
// solely under an automated test (NODE_ENV==="test") that neither redirected the
// home nor set an AGENT_KIT_SKIP_* hatch. `tool` names the binary for the error.
export function execInstaller(fx: DeployFsExec, req: ExecRequest, tool: string): ExecResult {
  if (isAutomatedTest() && !fx.targets.isChildEnvRedirected()) {
    throw new DeployError({
      reason: "not_redirected",
      message: `refusing to run real ${tool} installer in a test without a redirected home (${join(homedir(), ".claude")}); redirect HIVE_*_HOME or set AGENT_KIT_SKIP_*`,
      tool,
    });
  }
  const env = fx.targets.childEnv(process.env);
  return fx.exec(req, env);
}

// True only when running under Hive's own `bun test` suite (which sets
// NODE_ENV=test); false for the dev-run and packaged daemon.
function isAutomatedTest(): boolean {
  return process.env.NODE_ENV === "test";
}

export function probeBinary(fx: DeployFsExec, name: string): boolean {
  return fx.probe(name, fx.targets.childEnv(process.env));
}

// ---- production wiring ----

// On Windows the external CLIs are `.cmd`/`.ps1` shims (`claude.cmd`, `npx.cmd`,
// `git` is a real exe) that a bare `Bun.spawnSync(["claude", ...])` cannot
// resolve — it ENOENTs. Route through `cmd /c` on win32 so the shim is found,
// exactly as the upstream agent-kit does (`shell: process.platform==="win32"`).
// PROBE and EXEC must resolve identically, or a probe can pass while the install
// spawn ENOENTs (the asymmetry that escaped the typed error channel).
function spawnViaShell(
  cmd: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
): { exitCode: number | null; stdout: string; stderr: string } {
  const onWindows = process.platform === "win32";
  const finalCmd = onWindows ? ["cmd", "/c", ...cmd] : cmd;
  try {
    const proc = Bun.spawnSync({
      cmd: finalCmd,
      cwd: opts.cwd,
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout?.toString() ?? "",
      stderr: proc.stderr?.toString() ?? "",
    };
  } catch (err) {
    // A spawn failure (ENOENT for a genuinely-missing binary, even via the
    // shell) is a non-zero result here — never an untyped throw escaping the
    // deploy's typed error channel.
    return { exitCode: -1, stdout: "", stderr: String(err) };
  }
}

export function bunExec(req: ExecRequest, env: NodeJS.ProcessEnv): ExecResult {
  const r = spawnViaShell([req.command, ...req.args], { cwd: req.cwd, env });
  return { status: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function bunBinaryProbe(name: string, env: NodeJS.ProcessEnv): boolean {
  return spawnViaShell([name, "--version"], { env }).exitCode === 0;
}

// Convenience: read a directory's entries safely (used to probe skill folders).
export function listDirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
