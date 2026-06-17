// Playwright global setup. Compiles the shell TS and builds the UI dist
// once before any e2e tests run, so Electron can load file://ui/dist/index.html.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export default async function globalSetup(): Promise<void> {
  const repoRoot = resolve(__dirname, "..", "..");

  // 1. Compile shell to dist/
  const shellMain = resolve(repoRoot, "shell", "dist", "main.js");
  if (!existsSync(shellMain) || process.env.FORCE_BUILD === "1") {
    console.log("[global-setup] building shell…");
    execSync("bunx tsc", { cwd: resolve(repoRoot, "shell"), stdio: "inherit" });
  }

  // 2. Build UI dist/
  const uiIndex = resolve(repoRoot, "ui", "dist", "index.html");
  if (!existsSync(uiIndex) || process.env.FORCE_BUILD === "1") {
    console.log("[global-setup] building ui…");
    execSync("bun run build", { cwd: resolve(repoRoot, "ui"), stdio: "inherit" });
  }
}
