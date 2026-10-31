import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const artifactsRoot =
  process.env.HIVE_E2E_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "hive-shell-e2e-"));
process.env.HIVE_E2E_ARTIFACTS = artifactsRoot;

export default defineConfig({
  testDir: "./tests",
  // .e2e.ts so bun test (which targets .spec/.test) doesn't pick these up.
  testMatch: ["**/*.e2e.ts"],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  outputDir: join(artifactsRoot, "test-results"),
  reporter: [["line"], ["json", { outputFile: join(artifactsRoot, "test-results.json") }]],
  use: {
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Build the UI bundle once before any test runs.
  globalSetup: "./tests/global-setup.ts",
});
