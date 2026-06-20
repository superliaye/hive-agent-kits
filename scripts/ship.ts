// Ship orchestrator: builds UI, compiles the daemon to a standalone binary,
// stages everything into packages/shell/, runs @electron/packager. End result:
// a folder under packages/shell/release/ containing Hive.exe (Windows),
// Hive.app (macOS), or Hive (Linux). Double-click to run.
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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`\n→ ${cmd} ${args.join(" ")}  [cwd=${cwd}]`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin });
  if (result.status !== 0) {
    throw new Error(`step failed: ${cmd} ${args.join(" ")} (exit ${result.status})`);
  }
}

console.log("=== Building UI ===");
run("bun", ["run", "build"], join(REPO_ROOT, "packages", "ui"));

console.log("\n=== Compiling shell (tsc) ===");
run("bunx", ["tsc"], join(REPO_ROOT, "packages", "shell"));

console.log("\n=== Compiling daemon binary ===");
const stagingDir = join(REPO_ROOT, "packages", "shell", "staging");
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
run(
  "bun",
  [
    "build",
    "--compile",
    `--target=${COMPILE_TARGET}`,
    "packages/daemon/src/server/start.ts",
    "--outfile",
    join("packages", "shell", "staging", `hive-daemon${EXE}`),
  ],
  REPO_ROOT,
);

console.log("\n=== Staging UI into packages/shell/ ===");
const uiDistTarget = join(REPO_ROOT, "packages", "shell", "ui-dist");
rmSync(uiDistTarget, { recursive: true, force: true });
cpSync(join(REPO_ROOT, "packages", "ui", "dist"), uiDistTarget, { recursive: true });

// Stage the shell's production dependencies into its own node_modules so the
// packaged app bundles them. The workspace's hoisted linker resolves @hive/shell's
// runtime deps from the root node_modules, leaving packages/shell/node_modules
// without them — but @electron/packager only copies the app dir's own tree, so an
// unstaged dep would be absent at runtime. We copy each declared prod dep from the
// root install, then package with --no-prune (the dep walk galactus does on a
// hoisted layout fails; we've curated the tree ourselves). This stages only the
// top-level declared deps — a dep that itself has runtime dependencies would need
// its transitive tree too, so we assert each is dependency-free and fail loudly at
// ship time rather than ship a module-not-found app (zod, the only dep today, is).
function depsOf(pkgDir: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return pkg.dependencies ?? {};
}

console.log("\n=== Staging shell production deps ===");
const shellNodeModules = join(REPO_ROOT, "packages", "shell", "node_modules");
for (const dep of Object.keys(depsOf(join(REPO_ROOT, "packages", "shell")))) {
  const from = join(REPO_ROOT, "node_modules", dep);
  const to = join(shellNodeModules, dep);
  if (!existsSync(from)) {
    throw new Error(`shell prod dep "${dep}" not found at ${from} — run bun install`);
  }
  const transitive = Object.keys(depsOf(from));
  if (transitive.length > 0) {
    throw new Error(
      `shell prod dep "${dep}" has its own runtime deps (${transitive.join(", ")}); ` +
        "the staging loop copies only top-level deps — extend it to walk the transitive tree.",
    );
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: true });
  console.log(`  staged ${dep}`);
}

console.log("\n=== Packaging with @electron/packager ===");
const releaseDir = join(REPO_ROOT, "packages", "shell", "release");
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
    // Curated app-dir node_modules (prod deps staged above); skip galactus's
    // prune walk, which fails to resolve the hoisted-to-root dep tree.
    "--no-prune",
    // Renderer/main code lives under packages/shell/ (dist + ui-dist). The
    // daemon binary goes alongside as extraResource (sits in Resources/,
    // accessible via process.resourcesPath).
    `--extra-resource=${join(stagingDir, `hive-daemon${EXE}`)}`,
    // Exclude build artifacts and dev-only files. Plain regex strings
    // without `|`/`$` so the Windows shell doesn't mangle them. Patterns match
    // the path relative to the app dir, rooted with a leading slash.
    "--ignore=staging",
    "--ignore=release",
    "--ignore=test-results",
    "--ignore=tests",
    "--ignore=playwright.config",
    // Anchored to the app's OWN src/ — unanchored `/src/` would also strip a
    // staged dep's top-level src/ (e.g. zod/src) from node_modules.
    "--ignore=^/src/",
    "--ignore=tsconfig.json",
    // Type-only packages are never needed at runtime; --no-prune would otherwise
    // ship them (the hoisted linker copies @types/node into shell's node_modules).
    "--ignore=^/node_modules/@types/",
  ],
  join(REPO_ROOT, "packages", "shell"),
);

console.log("\n=== Verifying build ===");
const appDir = join(releaseDir, `Hive-${ELECTRON_PLATFORM}-x64`);
// The two artifacts that make the folder actually runnable: the Electron
// launcher and the self-contained daemon binary (in Resources/). Missing
// either means a broken ship.
const artifacts: Array<[string, string]> = [
  [`Hive${EXE}`, join(appDir, `Hive${EXE}`)],
  [`resources/hive-daemon${EXE}`, join(appDir, "resources", `hive-daemon${EXE}`)],
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
