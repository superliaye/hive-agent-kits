// Ship orchestrator: builds UI, compiles the daemon to a standalone binary,
// stages everything into shell/, runs @electron/packager. End result: a
// folder under shell/release/ containing Hive.exe (Windows), Hive.app
// (macOS), or Hive (Linux). Double-click to run.
//
// We use @electron/packager instead of electron-builder because the latter
// always downloads `winCodeSign` on Windows, which contains macOS .dylib
// symlinks 7za cannot extract without Developer Mode / admin. packager
// just bundles the app with Electron's binary; no signing-cache dance.
// Trade-off: no installer (.msi / .dmg). The output is a directory the
// user copies and runs from. Add electron-builder back when a signing
// cert lands and a CI host with the right perms is available.
//
// Run via: `bun run ship`.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const isWin = process.platform === "win32";
const EXE = isWin ? ".exe" : "";

const COMPILE_TARGET =
  process.platform === "win32"
    ? "bun-windows-x64"
    : process.platform === "darwin"
      ? "bun-darwin-x64"
      : "bun-linux-x64";

const ELECTRON_PLATFORM =
  process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`\n→ ${cmd} ${args.join(" ")}  [cwd=${cwd}]`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin });
  if (result.status !== 0) {
    throw new Error(`step failed: ${cmd} ${args.join(" ")} (exit ${result.status})`);
  }
}

console.log("=== Building UI ===");
run("bun", ["run", "build"], join(REPO_ROOT, "ui"));

console.log("\n=== Compiling shell (tsc) ===");
run("bunx", ["tsc"], join(REPO_ROOT, "shell"));

console.log("\n=== Compiling daemon binary ===");
const stagingDir = join(REPO_ROOT, "shell", "staging");
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
run(
  "bun",
  [
    "build",
    "--compile",
    `--target=${COMPILE_TARGET}`,
    "src/server/start.ts",
    "--outfile",
    join("shell", "staging", `hive-daemon${EXE}`),
  ],
  REPO_ROOT,
);

console.log("\n=== Staging UI + bundled into shell/ ===");
const uiDistTarget = join(REPO_ROOT, "shell", "ui-dist");
rmSync(uiDistTarget, { recursive: true, force: true });
cpSync(join(REPO_ROOT, "ui", "dist"), uiDistTarget, { recursive: true });
cpSync(join(REPO_ROOT, "bundled"), join(stagingDir, "bundled"), { recursive: true });

console.log("\n=== Packaging with @electron/packager ===");
const releaseDir = join(REPO_ROOT, "shell", "release");
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
run(
  "bunx",
  [
    "electron-packager",
    ".",
    "Hive",
    `--platform=${ELECTRON_PLATFORM}`,
    "--arch=x64",
    `--out=${releaseDir}`,
    "--overwrite",
    // Renderer/main code lives under shell/ (dist + ui-dist). Bundled and
    // daemon go alongside as extraResource (sits in Resources/, accessible
    // via process.resourcesPath).
    `--extra-resource=${join(stagingDir, `hive-daemon${EXE}`)}`,
    `--extra-resource=${join(stagingDir, "bundled")}`,
    // Exclude build artifacts and dev-only files. Plain regex strings
    // without `|`/`$` so the Windows shell doesn't mangle them.
    "--ignore=staging",
    "--ignore=release",
    "--ignore=test-results",
    "--ignore=tests",
    "--ignore=playwright.config",
    "--ignore=/src/",
    "--ignore=tsconfig.json",
  ],
  join(REPO_ROOT, "shell"),
);

console.log("\n=== Verifying build ===");
const appDir = join(releaseDir, `Hive-${ELECTRON_PLATFORM}-x64`);
// The three artifacts that make the folder actually runnable: the Electron
// launcher, the bundled self-contained daemon (in Resources/), and the bundled
// capabilities the daemon loads. Missing any means a broken ship.
const artifacts: Array<[string, string]> = [
  [`Hive${EXE}`, join(appDir, `Hive${EXE}`)],
  [`resources/hive-daemon${EXE}`, join(appDir, "resources", `hive-daemon${EXE}`)],
  ["resources/bundled", join(appDir, "resources", "bundled")],
];
let ok = true;
for (const [label, p] of artifacts) {
  const st = existsSync(p) ? statSync(p) : null;
  ok = ok && st !== null;
  const info = !st ? "missing" : st.isDirectory() ? "dir" : `${(st.size / 1e6).toFixed(1)}MB`;
  console.log(`  ${st ? "✓" : "✗"} ${label}  (${info})`);
}

console.log(`\nApp folder: ${appDir}`);
console.log(`Run: double-click Hive${EXE} inside it.`);
console.log(`STATUS: ${ok ? "PASS" : "FAIL"}`);
if (!ok) process.exitCode = 1;
