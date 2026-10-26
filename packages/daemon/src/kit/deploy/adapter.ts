// Deploy fs/exec adapter — the single narrow I/O boundary for Deploy. All
// writes + external execs go through here, against the redirected child env
// from the DeployTargets port. Injectable so a test can assert what the exec
// adapter ran.

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DeployError } from "../effect/errors.ts";
import type { DeployTargets } from "../targets.ts";
import { type SkillFile, skillFileMode } from "./transforms.ts";

export type ExecResult = { status: number; stdout: string; stderr: string };
export type ExecRequest = { command: string; args: string[]; cwd?: string; stdin?: string };

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

export function writeSkillFolder(dest: string, files: readonly SkillFile[]): void {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const full = join(dest, f.rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.bytes);
    chmodSync(full, f.mode);
  }
}

export function writeFileAt(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
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
          mode: skillFileMode(lstatSync(full).mode),
          bytes: readFileSync(full),
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
// solely under an automated test (NODE_ENV==="test") that did not redirect the
// home. `tool` names the binary for the error.
export function execInstaller(fx: DeployFsExec, req: ExecRequest, tool: string): ExecResult {
  if (isAutomatedTest() && !fx.targets.isChildEnvRedirected()) {
    throw new DeployError({
      reason: "not_redirected",
      message: `refusing to run real ${tool} installer in a test without a redirected home (${join(homedir(), ".claude")}); redirect HIVE_*_HOME`,
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

const inside = (path: string, dir: string) =>
  path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`);

// A repository's own script runs with CODEX_HOME pinned to the Codex target. When
// the homes are redirected, no variable but PATH may point into the real home
// outside the redirected HOME, so that HOME is the only home the script sees.
// The dev sandbox lives inside the real home, so "outside" matters.
export function repoCommandEnv(targets: DeployTargets, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = targets.childEnv(base);
  env.CODEX_HOME = targets.codexHome();
  const home = env.HOME;
  if (!targets.isChildEnvRedirected() || !home) return env;
  const realHome = homedir();
  for (const [name, value] of Object.entries(env)) {
    if (name === "PATH" || value === undefined) continue;
    if (inside(value, realHome) && !inside(value, home)) delete env[name];
  }
  return env;
}

// A redirected HOME hides ~/.npmrc, so npm and bun could not reach the
// configured registry. Copies its `registry=` lines in, never its credentials.
function seedRegistry(home: string): void {
  const real = join(homedir(), ".npmrc");
  const seeded = join(home, ".npmrc");
  if (real === seeded || !existsSync(real)) return;
  const lines = readFileSync(real, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("registry="));
  const existing = existsSync(seeded) ? readFileSync(seeded, "utf8") : "";
  const missing = lines.filter((line) => !existing.split(/\r?\n/).includes(line));
  if (missing.length === 0) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileAt(seeded, `${existing}${separator}${missing.join("\n")}\n`);
}

export function execRepoCommand(fx: DeployFsExec, req: ExecRequest, tool: string): ExecResult {
  if (isAutomatedTest() && !fx.targets.isChildEnvRedirected()) {
    throw new DeployError({
      reason: "not_redirected",
      message: `refusing to run ${tool} from a repository in a test without a redirected home`,
      tool,
    });
  }
  const env = repoCommandEnv(fx.targets, process.env);
  if (fx.targets.isChildEnvRedirected() && env.HOME) seedRegistry(env.HOME);
  return fx.exec(req, env);
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
  opts: { cwd?: string; env: NodeJS.ProcessEnv; stdin?: string },
): { exitCode: number | null; stdout: string; stderr: string } {
  const onWindows = process.platform === "win32";
  const finalCmd = onWindows ? ["cmd", "/c", ...cmd] : cmd;
  try {
    const proc = Bun.spawnSync({
      cmd: finalCmd,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
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
  const r = spawnViaShell([req.command, ...req.args], { cwd: req.cwd, env, stdin: req.stdin });
  return { status: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function bunBinaryProbe(name: string, env: NodeJS.ProcessEnv): boolean {
  return spawnViaShell([name, "--version"], { env }).exitCode === 0;
}
