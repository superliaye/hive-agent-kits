// The core slice e2e: unbind a Skill on Root, save, verify the runtime fork
// was written and audited; then reset, verify the fork is gone.

import { _electron as electron, expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SHELL_DIR = resolve(REPO_ROOT, "shell");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        rej(new Error("could not allocate port"));
        return;
      }
      const port = addr.port;
      srv.close(() => res(port));
    });
  });
}

function readCatalogAuditRows(auditDbPath: string): Array<{
  event_type: string;
  agent_id: string | null;
  payload: string;
}> {
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(auditDbPath)}, { readonly: true });
    const rows = db
      .query("SELECT event_type, agent_id, payload FROM audit_events WHERE source = 'catalog' ORDER BY ts, seq")
      .all();
    process.stdout.write(JSON.stringify(rows));
  `;
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun audit query failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

let runtimeRoot: string;
let port: number;

test.beforeEach(async () => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "hive-e2e-"));
  port = await freePort();
});

test.afterEach(() => {
  if (existsSync(runtimeRoot)) {
    try {
      rmSync(runtimeRoot, { recursive: true, force: true });
    } catch {
      // SQLite WAL may briefly hold files on Windows. Best effort.
    }
  }
});

test("binding fork-write — unbind my-commit, save, then reset", async () => {
  test.setTimeout(120_000);
  // ELECTRON_RUN_AS_NODE forces Electron into plain-Node mode, which breaks
  // the GUI launch. Strip it before forwarding the env.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") cleanEnv[k] = v;
  }
  cleanEnv.HIVE_RUNTIME_ROOT = runtimeRoot;
  cleanEnv.HIVE_PORT = String(port);
  cleanEnv.NODE_ENV = "production";

  const app = await electron.launch({
    args: ["dist/main.js"],
    cwd: SHELL_DIR,
    env: cleanEnv,
    timeout: 30_000,
  });

  // Pipe Electron's stdio through Playwright's stdout so we see what's happening.
  app.process().stdout?.on("data", (b) => process.stdout.write(`[el-out] ${b}`));
  app.process().stderr?.on("data", (b) => process.stdout.write(`[el-err] ${b}`));

  const window = await app.firstWindow({ timeout: 30_000 });
  window.on("pageerror", (err) => console.log(`[renderer error] ${err.message}`));
  await window.waitForLoadState("domcontentloaded");

  // Wait for Root to appear in the sidebar.
  await window.locator('[data-testid="agent-root"]').waitFor({ timeout: 20_000 });
  await window.locator('[data-testid="agent-root"]').click();

  // Bindings is the default sub-tab. Find the my-commit row.
  const checkbox = window.locator(
    '[data-testid="bind-skill-my-commit"] input[type="checkbox"]',
  );
  await checkbox.waitFor({ timeout: 10_000 });
  await expect(checkbox).toBeChecked();

  await checkbox.uncheck();

  // Pending drawer appears with exactly one unbind entry.
  await window
    .locator('[data-testid="pending-list"] li')
    .first()
    .waitFor({ timeout: 5_000 });
  await expect(window.locator('[data-testid="pending-list"] li')).toHaveCount(1);

  await window.locator('[data-testid="save-button"]').click();

  // Ground truth: the fork file appears on disk. Poll because the PATCH is
  // async and there's a render delay before the click handler resolves.
  const forkPath = join(runtimeRoot, "agents", "root", "HARNESS.md");
  await expect.poll(() => existsSync(forkPath), { timeout: 15_000 }).toBe(true);

  const auditRows = readCatalogAuditRows(join(runtimeRoot, "audit.db"));
  const updated = auditRows.find((r) => r.event_type === "harness.updated");
  expect(updated).toBeDefined();
  expect(updated?.agent_id).toBe("root");
  const payload = JSON.parse(updated?.payload ?? "{}") as {
    source: string;
    diff: { kind: string; name: string; action: string };
  };
  expect(payload.source).toBe("ui");
  expect(payload.diff).toMatchObject({
    kind: "skill",
    name: "my-commit",
    action: "unbind",
  });

  // Reset: wait for the button to become enabled (depends on the agent
  // refetch landing), click, then poll for fork removal.
  await expect(window.locator('[data-testid="reset-button"]')).toBeEnabled({
    timeout: 15_000,
  });
  await window.locator('[data-testid="reset-button"]').click();
  await expect.poll(() => existsSync(forkPath), { timeout: 15_000 }).toBe(false);

  // app.close() can hang on Windows if the spawned bun daemon doesn't exit
  // promptly. Race it against a hard kill fallback.
  await Promise.race([
    app.close(),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          app.process().kill("SIGKILL");
        } catch {
          // already dead
        }
        resolve();
      }, 5_000);
    }),
  ]);
});
