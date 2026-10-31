import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default async function globalSetup(): Promise<void> {
  const packagesRoot = resolve(__dirname, "..", "..");
  const bun = process.platform === "win32" ? "bun.exe" : "bun";
  execFileSync(bun, ["run", "build"], { cwd: resolve(packagesRoot, "shell"), stdio: "inherit" });
  execFileSync(bun, ["run", "build"], { cwd: resolve(packagesRoot, "ui"), stdio: "inherit" });
}
