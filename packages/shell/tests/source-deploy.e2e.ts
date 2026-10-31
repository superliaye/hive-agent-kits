import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DeploymentOverview } from "@hive/contract";
import { AppearanceConfigSchema } from "@hive/theming/schema";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";
import { z } from "zod";

const SHELL_DIR = resolve(__dirname, "..");
const SKILL_NAME = "hive-e2e-skill";
const SKILL_BYTES = `---\nname: ${SKILL_NAME}\ndescription: A local deployment fixture.\n---\nRead the local fixture and report its exact contents.\n`;
const DeployAuditRows = z.array(
  z.object({
    source: z.literal("deploy"),
    event_type: z.literal("deploy.accepted"),
    run_id: z.null(),
    agent_id: z.null(),
    payload: z
      .object({
        operationId: z.string(),
        selectionRevision: z.number().int(),
        perKindActionCounts: z.record(z.number().int()),
        targetClis: z.array(z.enum(["claude", "codex"])),
      })
      .strict(),
  }),
);

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function readApi<T>(
  port: number,
  runtimeRoot: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const token = readFileSync(join(runtimeRoot, ".token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.ok, `${path} returned ${response.status}`).toBe(true);
  return schema.parse(await response.json());
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try {
    // Playwright launches Electron as a process-group leader on Unix.
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;
  const timeout = setTimeout(() => {
    if (pid !== undefined) killProcessTree(pid);
  }, 5_000);
  try {
    await app.close();
  } finally {
    clearTimeout(timeout);
    if (pid !== undefined) killProcessTree(pid);
  }
}

test("add a local Source, select its Skill, and Deploy to both CLI homes", async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), "hive-shell-deploy-"));
  let app: ElectronApplication | undefined;
  try {
    const sourceRoot = join(root, "source");
    const runtimeRoot = join(root, "runtime");
    const homesRoot = join(root, "homes");
    const claudeHome = join(homesRoot, ".claude");
    const codexHome = join(homesRoot, ".codex");
    const agentsHome = join(homesRoot, ".agents");
    const skillRoot = join(sourceRoot, "skills", SKILL_NAME);
    mkdirSync(skillRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(skillRoot, "SKILL.md"), SKILL_BYTES);
    writeFileSync(join(skillRoot, "reference.txt"), "Local fixture bytes.\n");
    execFileSync("git", ["init", "--quiet"], { cwd: sourceRoot });
    execFileSync("git", ["add", "."], { cwd: sourceRoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Hive E2E",
        "-c",
        "user.email=hive-e2e@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(root, "no-hooks")}`,
        "commit",
        "--quiet",
        "-m",
        "Local published Skill fixture",
      ],
      { cwd: sourceRoot },
    );
    writeFileSync(
      join(runtimeRoot, "config.yaml"),
      JSON.stringify({
        sources: { workingTreeRoots: [sourceRoot] },
        developer: { allowRealHomeDeploy: false },
      }),
    );

    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE" && !key.startsWith("HIVE_")) {
        env[key] = value;
      }
    }
    Object.assign(env, {
      HIVE_RUNTIME_ROOT: runtimeRoot,
      HIVE_PORT: String(port),
      HIVE_CDP_PORT: "0",
      HIVE_CLAUDE_HOME: claudeHome,
      HIVE_CODEX_HOME: codexHome,
      HIVE_AGENTS_HOME: agentsHome,
      HIVE_LEDGER_PATH: join(root, "ledger.json"),
      NODE_ENV: "production",
    });
    app = await electron.launch({
      args: [
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `--user-data-dir=${join(root, "electron-profile")}`,
        "dist/main.js",
      ],
      cwd: SHELL_DIR,
      env,
      timeout: 30_000,
    });
    app.process().stdout?.on("data", (bytes) => process.stdout.write(bytes));
    app.process().stderr?.on("data", (bytes) => process.stderr.write(bytes));
    const window = await app.firstWindow({ timeout: 30_000 });
    await expect(window.getByTestId("kit-deploy-page")).toBeVisible({ timeout: 20_000 });
    await window.getByTestId("add-source-input").fill(sourceRoot);
    await window.getByTestId("add-source-submit").click();
    await expect(window.getByTestId("add-source-success")).toBeVisible({ timeout: 20_000 });

    const skill = window.getByTestId(`kit-row-skill-${SKILL_NAME}`);
    await expect(skill).toHaveAttribute("aria-checked", "false");
    await window.getByTestId("kit-target-codex").check();
    await skill.click();
    await expect(skill).toHaveAttribute("aria-checked", "true");
    await expect(window.getByTestId("kit-diff-summary")).toContainText("+1 Added");
    for (const home of [claudeHome, agentsHome]) {
      expect(existsSync(join(home, "skills", SKILL_NAME, "SKILL.md"))).toBe(false);
    }
    await expect(window.getByTestId("kit-deploy")).toBeEnabled();
    await window.getByTestId("kit-deploy").click();

    for (const home of [claudeHome, agentsHome]) {
      const deployedSkill = join(home, "skills", SKILL_NAME);
      await expect.poll(() => existsSync(join(deployedSkill, "SKILL.md"))).toBe(true);
      expect(readFileSync(join(deployedSkill, "SKILL.md"), "utf8")).toBe(SKILL_BYTES);
      expect(readFileSync(join(deployedSkill, "reference.txt"), "utf8")).toBe(
        "Local fixture bytes.\n",
      );
    }
    const state = window.getByTestId(`kit-state-skill-${SKILL_NAME}`);
    await expect(state).toContainText("In sync", { timeout: 20_000 });
    await expect(state).toContainText("Succeeded");
    await expect(state.getByText("Verified", { exact: true })).toHaveCount(2);
    await expect(window.getByTestId("kit-deploy")).toHaveText("Up to date");

    const overview = await readApi(port, runtimeRoot, "/api/kit/overview", DeploymentOverview);
    expect(overview.sources).toHaveLength(1);
    expect(overview.sources[0]?.recipe?.id).toBe("published-skills");
    expect(overview.rows).toHaveLength(1);
    expect(overview.rows[0]).toMatchObject({
      key: { kind: "skill", name: SKILL_NAME },
      desired: "on",
      reconciliation: "in_sync",
      lastAttempt: { state: "succeeded" },
    });
    expect(overview.rows[0]?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", observation: "verified" }),
        expect.objectContaining({ target: "codex", observation: "verified" }),
      ]),
    );
    expect(overview.diff.entries).toEqual([]);
    expect(overview.activeOperation).toBeNull();
    expect(overview.lastOperation?.state).toBe("completed");

    const rows = await readApi(
      port,
      runtimeRoot,
      "/api/audit?source=deploy&event_type=deploy.accepted",
      DeployAuditRows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      operationId: overview.lastOperation?.operationId,
      selectionRevision: overview.selectionRevision,
      perKindActionCounts: { skill: 2 },
      targetClis: ["claude", "codex"],
    });

    await test.step("recover from malformed appearance cache on reload", async () => {
      const rendererErrors: string[] = [];
      window.on("pageerror", (error) => rendererErrors.push(error.message));
      await window.evaluate(() => {
        localStorage.setItem("hive.appearance.preferences.v2", JSON.stringify({ mode: "dark" }));
      });
      await window.reload();
      await expect(window.getByTestId("kit-deploy-page")).toBeVisible();
      await expect(window.getByTestId(`kit-state-skill-${SKILL_NAME}`)).toContainText("In sync");
      const appearance = await readApi(
        port,
        runtimeRoot,
        "/api/appearance",
        AppearanceConfigSchema,
      );
      await expect
        .poll(async () =>
          window.evaluate(() => {
            const cached = localStorage.getItem("hive.appearance.preferences.v2");
            return cached ? JSON.parse(cached) : null;
          }),
        )
        .toEqual(appearance);
      expect(rendererErrors).toEqual([]);
    });
  } finally {
    try {
      if (app) await closeApp(app);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
