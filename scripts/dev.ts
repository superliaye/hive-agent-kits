// Dev orchestrator: prepares deps, tears down any prior stack for this instance,
// opens one terminal per stack piece (minimized on Windows so they don't steal
// focus), then verifies health and prints a STATUS block. Each terminal owns its
// piece's lifecycle — close the window to stop it.
//
//   bun run dev:full                   full GUI stack (instance 0)
//   bun run dev:full -- --daemon-only  daemon API only, no Vite/Electron
//   bun run dev:full -- --instance 1   a second, isolated stack
//   bun run dev:full -- --fixture-sources  full GUI stack with offline fixture Sources
//
// --instance N (default 0) shifts every port by N (daemon 3117+N, vite 5173+N,
// electron CDP 9333+N) and isolates the runtime root (~/.hive, else ~/.hive-N),
// so a second stack runs in parallel without colliding. Attach the visual loop
// to the real window on CDP 9333+N (scripts/screenshot.ts --cdp 9333+N).
//
// Windows: cmd.exe windows opened via `start "title" /min cmd /k …`
// macOS:   Terminal.app via osascript
// Linux:   x-terminal-emulator / gnome-terminal / xterm (first one found)

import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Catalog, KitStateSchema, Source } from "@hive/contract";

type Job = {
  title: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
};

function parseInstance(argv: string[]): number {
  const i = argv.indexOf("--instance");
  if (i === -1) return 0;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new Error(`--instance must be 0..99 (got ${raw})`);
  }
  return n;
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const daemonOnly = process.argv.includes("--daemon-only");
const fixtureSources = process.argv.includes("--fixture-sources");
const instance = parseInstance(process.argv);
const DAEMON_PORT = 3117 + instance;
const VITE_PORT = 5173 + instance;
const CDP_PORT = 9333 + instance;
const RUNTIME_ROOT =
  instance === 0
    ? join(homedir(), fixtureSources ? ".hive-fixtures" : ".hive")
    : join(homedir(), fixtureSources ? `.hive-fixtures-${instance}` : `.hive-${instance}`);
const fixtureRegistryExisted = fixtureSources && existsSync(join(RUNTIME_ROOT, "sources.json"));

function fixtureEnv(): Record<string, string> {
  if (!fixtureSources) return {};
  const homesRoot = join(RUNTIME_ROOT, "homes");
  return {
    HIVE_DEV_FIXTURE_SOURCES: "1",
    HIVE_CLAUDE_HOME: join(homesRoot, ".claude"),
    HIVE_CODEX_HOME: join(homesRoot, ".codex"),
    HIVE_AGENTS_HOME: join(homesRoot, ".agents"),
    HIVE_LEDGER_PATH: join(homesRoot, ".agent-kit", "manifest.json"),
  };
}

const jobs: Job[] = [
  {
    title: "Hive Daemon",
    cmd: "bun --watch packages/daemon/src/server/start.ts",
    env: { HIVE_PORT: String(DAEMON_PORT), HIVE_RUNTIME_ROOT: RUNTIME_ROOT, ...fixtureEnv() },
  },
  {
    title: "Hive UI (Vite)",
    cmd: `bun run dev --port ${VITE_PORT}`,
    cwd: "packages/ui",
  },
  // Shell runs last so daemon + Vite are already serving by the time Electron
  // probes them. HIVE_UI_MODE=dev tells main.ts to load from the Vite URL
  // instead of ui/dist/. ELECTRON_RUN_AS_NODE is unset here because if it's
  // set globally in the user's env (Microsoft default, see e2e harness),
  // Electron starts in plain-Node mode and never creates a window. HIVE_CDP_PORT
  // opens the per-instance DevTools port the visual loop attaches to.
  {
    title: "Hive Shell (Electron)",
    cmd: "bun run start",
    cwd: "packages/shell",
    env: {
      HIVE_UI_MODE: "dev",
      ELECTRON_RUN_AS_NODE: "",
      HIVE_PORT: String(DAEMON_PORT),
      HIVE_RUNTIME_ROOT: RUNTIME_ROOT,
      ...fixtureEnv(),
      HIVE_UI_DEV_URL: `http://127.0.0.1:${VITE_PORT}`,
      HIVE_CDP_PORT: String(CDP_PORT),
    },
  },
];

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// Staging dir for the per-job launcher scripts. Writing each command to its
// own file (`.bat` on Windows, `.sh` elsewhere) sidesteps quoting and `&&`
// pitfalls — most importantly, `set VAR=` (clear an env var) is unreliable
// when chained with `&&` on Windows cmd.
const stageDir = mkdtempSync(join(tmpdir(), `hive-dev-i${instance}-`));

function writeBat(job: Job, fullCwd: string): string {
  const path = join(stageDir, `${job.title.replace(/\W+/g, "-")}.bat`);
  const envLines = Object.entries(job.env ?? {})
    .map(([k, v]) => `set ${k}=${v}`)
    .join("\r\n");
  const body = [`title ${job.title}`, `cd /d ${fullCwd}`, envLines, job.cmd]
    .filter((line) => line.length > 0)
    .join("\r\n");
  writeFileSync(path, `${body}\r\n`);
  return path;
}

function writeSh(job: Job, fullCwd: string): string {
  const path = join(stageDir, `${job.title.replace(/\W+/g, "-")}.sh`);
  const envLines = Object.entries(job.env ?? {})
    .map(([k, v]) => `export ${k}=${v}`)
    .join("\n");
  const body = ["#!/usr/bin/env bash", `cd '${fullCwd}'`, envLines, job.cmd]
    .filter((line) => line.length > 0)
    .join("\n");
  writeFileSync(path, `${body}\nexec bash\n`, { mode: 0o755 });
  return path;
}

function spawnTerminal(job: Job): void {
  const fullCwd = job.cwd ? resolve(REPO_ROOT, job.cwd) : REPO_ROOT;
  const opts: SpawnOptions = { detached: true, stdio: "ignore" };

  if (isWin) {
    // Each job's command list is written to a per-job .bat so cmd /k can run
    // it as a script — no quoting/chaining gotchas. /k keeps the window open
    // after the script exits.
    const bat = writeBat(job, fullCwd);
    // /min: land in the taskbar without stealing focus.
    spawn("cmd", ["/c", "start", `"${job.title}"`, "/min", "cmd", "/k", bat], opts);
    return;
  }
  if (isMac) {
    const sh = writeSh(job, fullCwd);
    const script = `tell application "Terminal" to do script "${sh}"`;
    spawn("osascript", ["-e", script], opts);
    return;
  }
  const sh = writeSh(job, fullCwd);
  const candidates: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["-T", job.title, "-e", "bash", sh]],
    ["gnome-terminal", ["--title", job.title, "--", "bash", sh]],
    ["xterm", ["-T", job.title, "-e", "bash", sh]],
  ];
  for (const [cmd, args] of candidates) {
    try {
      spawn(cmd, args, opts);
      return;
    } catch {
      // try next
    }
  }
  console.error(`No terminal emulator found. Run manually in three terminals:\n  ${job.cmd}`);
}

// Install deps before launching. `bun install` is near-instant when the
// lockfile is already satisfied, so this is cheap on a warm repo and the only
// thing that makes a freshly cloned or pulled (dependency-drifted) repo
// actually boot — without it the daemon and Vite start but silently fail to
// bind their ports. Daemon-only needs the root package alone.
function installAll(): void {
  console.log("→ bun install (workspace root)");
  const r = spawnSync("bun", ["install"], { cwd: REPO_ROOT, stdio: "inherit", shell: isWin });
  if (r.status !== 0) {
    console.error(`bun install failed (exit ${r.status})`);
    process.exit(1);
  }
}

// Fully tear down any prior Hive stack before relaunching, so repeated starts
// restart cleanly instead of piling up orphaned windows. Just freeing the
// ports would leave the empty cmd /k windows and the Electron behind.
function stopPriorStack(): void {
  if (isWin) {
    // Tear down only THIS instance. Its cmd host windows are staged under a
    // per-instance temp prefix (hive-dev-i<N>-); taskkill /T cascades each to
    // its bun + Electron children. The port sweep is the backstop that also
    // reaps an Electron orphaned from an already-closed window — it still holds
    // the CDP port (9333+N) until it exits. A parallel instance uses different
    // ports and a different prefix, so it's untouched.
    const cmd = [
      `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'hive-dev-i${instance}-' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }`,
      `Get-NetTCPConnection -State Listen -LocalPort ${DAEMON_PORT},${VITE_PORT},${CDP_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    ].join("; ");
    spawnSync("powershell", ["-NoProfile", "-Command", cmd], { stdio: "ignore" });
    return;
  }
  // mac/linux: a launcher can't reliably close terminal windows, but it can
  // free this instance's ports by killing whatever is bound to them.
  for (const port of [DAEMON_PORT, VITE_PORT, CDP_PORT]) {
    const found = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
    for (const pid of (found.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      spawnSync("kill", ["-9", pid], { stdio: "ignore" });
    }
  }
}

async function waitFor(timeoutMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // not up yet — retry until the deadline
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function daemonHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/ready`);
    return res.ok && ((await res.json()) as { status?: string }).status === "ok";
  } catch {
    return false;
  }
}

type Health = {
  daemon: boolean;
  vite: boolean;
  kitOk: boolean;
  cdp: boolean;
  fixtureSources: boolean;
};

async function verify(): Promise<Health> {
  const daemon = await waitFor(30_000, async () => {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/ready`);
    return res.ok && ((await res.json()) as { status?: string }).status === "ok";
  });

  const vite = daemonOnly
    ? false
    : await waitFor(15_000, async () => (await fetch(`http://127.0.0.1:${VITE_PORT}/`)).ok);

  // The Electron window exposes its dev CDP port once the renderer is up; the
  // /json/version probe proves the visual loop can actually attach (and is
  // instance-scoped — each window owns a distinct port).
  const cdp = daemonOnly
    ? false
    : await waitFor(
        30_000,
        async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok,
      );

  // Health-check the deploy-manager's kit surface (the agent stack is gone — ADR-0021).
  let kitOk = false;
  let fixtureSourcesOk = !fixtureSources;
  if (daemon) {
    try {
      const token = readFileSync(join(RUNTIME_ROOT, ".token"), "utf8").trim();
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/kit/catalog`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const catalog = res.ok ? Catalog.parse(await res.json()) : null;
      kitOk = catalog !== null;
      if (fixtureSources) {
        const sources = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/sources`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const parsedSources = Source.array().parse(await sources.json());
        const state = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/kit/state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const parsedState = KitStateSchema.parse(await state.json());
        const fixtureIds = parsedSources
          .filter((source) => source.id.startsWith("fixture-"))
          .map((source) => source.id);
        const freshSeedPresent =
          fixtureRegistryExisted ||
          ["fixture-alpha", "fixture-beta", "fixture-gamma"].every((id) => fixtureIds.includes(id));
        const activeFixtureIds = parsedSources
          .filter((source) => source.active && source.id.startsWith("fixture-"))
          .map((source) => source.id);
        const activeFixturesHealthy =
          activeFixtureIds.length === 0
            ? fixtureRegistryExisted
            : activeFixtureIds.every((id) => {
                const sync = parsedState.sync.find((entry) => entry.sourceId === id);
                const hasCatalogEntry = catalog?.entries.some((entry) =>
                  entry.sourceIds.includes(id),
                );
                return sync?.state === "local" && hasCatalogEntry;
              });
        fixtureSourcesOk = freshSeedPresent && activeFixturesHealthy;
      }
    } catch {
      // leave kitOk false — reported as a failure below
    }
  }

  return { daemon, vite, kitOk, cdp, fixtureSources: fixtureSourcesOk };
}

function printStatus(h: Health): void {
  // The CDP port is informational here (this is the human launcher — you can see
  // the window). The agent launcher, dev.ps1, gates PASS on it instead.
  const pass = daemonOnly
    ? h.daemon && h.kitOk && h.fixtureSources
    : h.daemon && h.vite && h.kitOk && h.fixtureSources;
  console.log(`\n=== Hive ${daemonOnly ? "daemon" : "dev stack"} (instance ${instance}) ===`);
  console.log(`  daemon    :${DAEMON_PORT} /api/ready → ${h.daemon ? "ok" : "unreachable"}`);
  console.log(`  kit       /api/kit/catalog → ${h.kitOk ? "ok" : "unreachable"}`);
  if (!daemonOnly) {
    console.log(`  vite      :${VITE_PORT} → ${h.vite ? "ok" : "unreachable"}`);
    console.log(
      `  electron  CDP :${CDP_PORT} → ${h.cdp ? "ok (visual loop ready)" : "unreachable"}`,
    );
  }
  if (fixtureSources) {
    console.log(`  fixtures  ${h.fixtureSources ? "present" : "missing"}`);
  }
  console.log(`  runtime   ${RUNTIME_ROOT}`);
  console.log(`  STATUS: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

// Daemon-only: reuse a healthy daemon if one is already up, so testing the API
// doesn't restart (and disturb) a running GUI stack.
const reuse = daemonOnly && !fixtureSources && (await daemonHealthy());
if (reuse) {
  console.log(`Daemon already healthy on :${DAEMON_PORT} — reusing (no restart).`);
} else {
  console.log(
    `Preparing Hive ${daemonOnly ? "daemon" : "dev stack"}${fixtureSources ? " with fixture Sources" : ""}...\n`,
  );
  installAll();
  stopPriorStack();

  const activeJobs = daemonOnly ? jobs.slice(0, 1) : jobs;
  console.log(
    `\nStarting Hive ${daemonOnly ? "daemon" : "dev stack"}${fixtureSources ? " with fixture Sources" : ""}...\n`,
  );
  for (const [i, job] of activeJobs.entries()) {
    const where = job.cwd ? ` (in ${job.cwd}/)` : "";
    console.log(`  ${i + 1}. ${job.title}: ${job.cmd}${where}`);
    spawnTerminal(job);
    // Stagger so the daemon and Vite are up before Electron probes them.
    if (i < activeJobs.length - 1) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  console.log(`\nClose a window to stop that piece. Daemon writes to ${RUNTIME_ROOT}.`);
  console.log(`(Launcher scripts staged at ${stageDir})`);
}

console.log("\nVerifying (up to ~30s for first boot)...");
printStatus(await verify());
