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
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { readReleaseMetadata } from "./release-manifest";
import { resolveShipTarget } from "./ship-target";

const REPO_ROOT = resolve(import.meta.dir, "..");
const isWin = process.platform === "win32";
const EXE = isWin ? ".exe" : "";
const { compileTarget, electronPlatform, electronArch } = resolveShipTarget(
  process.platform,
  process.arch,
);

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`\n→ ${cmd} ${args.join(" ")}  [cwd=${cwd}]`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin });
  if (result.status !== 0) {
    throw new Error(`step failed: ${cmd} ${args.join(" ")} (exit ${result.status})`);
  }
}

function sourceCommit(): string {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("could not resolve the exact Hive source commit");
  }
  return commit;
}

console.log("=== Building UI ===");
run("bun", ["run", "build"], join(REPO_ROOT, "packages", "ui"));

console.log("\n=== Compiling shell (tsc) ===");
run("bunx", ["tsc"], join(REPO_ROOT, "packages", "shell"));

console.log("\n=== Compiling daemon binary ===");
const stagingDir = join(REPO_ROOT, "packages", "shell", "staging");
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
const releaseMetadataPath = join(stagingDir, "hive-release.json");
const releaseMetadata = readReleaseMetadata(process.env, sourceCommit());
writeFileSync(releaseMetadataPath, `${JSON.stringify(releaseMetadata, null, 2)}\n`, {
  mode: 0o644,
});
run(
  "bun",
  [
    "build",
    "--compile",
    `--target=${compileTarget}`,
    "--define",
    `process.env.HIVE_BUILD_VERSION=${JSON.stringify(releaseMetadata.buildVersion)}`,
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
    `--platform=${electronPlatform}`,
    `--arch=${electronArch}`,
    `--out=${releaseDir}`,
    "--overwrite",
    // Curated app-dir node_modules (prod deps staged above); skip galactus's
    // prune walk, which fails to resolve the hoisted-to-root dep tree.
    "--no-prune",
    // Renderer/main code lives under packages/shell/ (dist + ui-dist). The
    // daemon binary goes alongside as extraResource (sits in Resources/,
    // accessible via process.resourcesPath).
    `--extra-resource=${join(stagingDir, `hive-daemon${EXE}`)}`,
    `--extra-resource=${releaseMetadataPath}`,
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
const appDir = join(releaseDir, `Hive-${electronPlatform}-${electronArch}`);
const executablePath =
  electronPlatform === "darwin"
    ? join(appDir, "Hive.app", "Contents", "MacOS", "Hive")
    : join(appDir, `Hive${EXE}`);
const resourcesDir =
  electronPlatform === "darwin"
    ? join(appDir, "Hive.app", "Contents", "Resources")
    : join(appDir, "resources");
// The launcher, standalone daemon, and release identity make a valid package.
const artifacts: Array<[string, string]> = [
  [`Hive${EXE}`, executablePath],
  [`resources/hive-daemon${EXE}`, join(resourcesDir, `hive-daemon${EXE}`)],
  ["resources/hive-release.json", join(resourcesDir, "hive-release.json")],
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
