import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // .e2e.ts so bun test (which targets .spec/.test) doesn't pick these up.
  testMatch: ["**/*.e2e.ts"],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["line"], ["json", { outputFile: "test-results.json" }]],
  use: {
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Build the UI bundle once before any test runs.
  globalSetup: "./tests/global-setup.ts",
});
