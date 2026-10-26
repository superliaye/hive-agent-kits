import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Source } from "@hive/contract";
import { Effect } from "effect";
import { DEFAULT_TREE_LIMITS } from "../acquisition/tree-guard.ts";
import { readCatalog } from "../catalog.ts";
import { hashSkillFiles } from "../deploy/artifact-hash.ts";
import { executeStagedDeploy, stageDeployPlan } from "../deploy-coordinator.ts";
import {
  openDeployOperationStore,
  StagedDeployPayloadSchema,
  stagedSkillFile,
} from "../deploy-operations.ts";
import { buildDeployPlan } from "../deploy-plan.ts";
import { openDeploymentStateStore } from "../deployment-state.ts";
import { readLedger } from "../ledger.ts";
import { commitMirror, materialize } from "../mirror.ts";
import { captureDeploymentSnapshot } from "../overview.ts";
import { recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, type MemoryFile, memorySnapshot, redirectHomeEnv } from "./helpers.ts";

const roots: string[] = [];

afterEach(() => {
  clearHomeEnv();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const source: Source = {
  id: "source-a",
  label: "Source A",
  locator: {
    kind: "git",
    repoUrl: "https://github.com/acme/stack",
    revision: { mode: "track", ref: "refs/heads/main" },
    subpath: ".",
  },
  origin: "https://github.com/acme/stack",
  kind: "git",
  active: true,
  createdAt: 0,
  rank: 1,
};

// Not UTF-8, so it can only survive as bytes.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0xc3,
]);

// Syncs `files` as the only Source, then deploys skill `name` to both CLIs from
// the Overview's plan through staging and a persisted operation payload.
async function syncAndDeploy(files: Record<string, MemoryFile>, name: string) {
  const root = mkdtempSync(join(tmpdir(), "skill-deploy-"));
  roots.push(root);
  const homes = redirectHomeEnv(root);
  const targets = failSafeDeployTargets();
  const { snapshot } = memorySnapshot(files);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recognition = yield* recognizeSource(recipeTree(snapshot, DEFAULT_TREE_LIMITS));
        const staged = yield* materialize(
          snapshot,
          recognition,
          targets.kitTmpRoot(),
          DEFAULT_TREE_LIMITS,
        );
        return yield* commitMirror(targets.mirrorRoot(source.id), staged);
      }),
    ),
  );
  const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
    now: () => 20,
  });
  const capture = () =>
    captureDeploymentSnapshot(targets, {
      sourceRegistry: { revision: 1, sources: [source] },
      catalog: readCatalog(targets, [source]),
      selection: {
        revision: 1,
        enabled: [{ key: { kind: "skill", name }, targets: ["claude", "codex"] }],
        removalIntents: [],
      },
      ledger: readLedger(targets),
      deploymentState: deploymentState.readAll(),
    });
  const accepted = capture();
  const plan = buildDeployPlan(accepted);
  const operations = openDeployOperationStore(join(root, "operations.json"), { now: () => 10 });
  operations.createQueued({
    operationId: "op",
    acceptedAt: 10,
    selectionRevision: 1,
    planToken: "token",
    plan,
    staged: stageDeployPlan(targets, accepted, plan),
  });
  await executeStagedDeploy(
    {
      fx: {
        targets,
        exec: async () => ({ status: 0, stdout: "", stderr: "" }),
        probe: async () => false,
      },
      deploymentState,
      now: () => 20,
    },
    operations.markRunning("op"),
    async (outcomes) => {
      operations.recordOutcomes("op", outcomes);
    },
  );
  const deployed = (target: "claude" | "codex") =>
    join(target === "claude" ? homes.claudeHome : homes.agentsHome, "skills", name);
  return { plan, deployed, replan: () => buildDeployPlan(capture()) };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

describe("byte-faithful skill deploy", () => {
  test("an upstream skill lands byte for byte with its exec bit and no kit rendering", async () => {
    const files: Record<string, MemoryFile> = {
      "skills/tool/SKILL.md":
        "---\nname: tool\ndescription: upstream tool\ndisable-model-invocation: true\n---\n<!-- include: x -->\n",
      "skills/tool/SOURCE.md": "upstream provenance\n",
      "skills/tool/run.sh": { exec: "#!/bin/sh\necho run\n" },
      "skills/tool/assets/logo.png": PNG,
    };
    const { plan, deployed, replan } = await syncAndDeploy(files, "tool");

    expect(plan.actions.map((action) => `${action.action} ${action.target}`)).toEqual([
      "add claude",
      "add codex",
    ]);
    for (const target of ["claude", "codex"] as const) {
      const dir = deployed(target);
      expect(filesUnder(dir)).toEqual(["SKILL.md", "SOURCE.md", "assets/logo.png", "run.sh"]);
      expect(new Uint8Array(readFileSync(join(dir, "assets/logo.png")))).toEqual(PNG);
      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("\n<!-- include: x -->\n");
      expect(readFileSync(join(dir, "SOURCE.md"), "utf8")).toBe("upstream provenance\n");
      expect(readFileSync(join(dir, "run.sh"), "utf8")).toBe("#!/bin/sh\necho run\n");
      expect(lstatSync(join(dir, "run.sh")).mode & 0o777).toBe(0o755);
      expect(lstatSync(join(dir, "assets/logo.png")).mode & 0o777).toBe(0o644);
    }
    expect(replan().actions).toEqual([]);
  });

  test("a capability kit skill still expands includes, drops SOURCE.md, and gets the Codex sidecar", async () => {
    const { deployed, replan } = await syncAndDeploy(
      {
        "capabilities/skills/alpha/SKILL.md":
          "---\nname: alpha\ndescription: kit\ndisable-model-invocation: true\n---\n<!-- include: greet -->\n",
        "capabilities/skills/alpha/SOURCE.md": "maintainer notes\n",
        "capabilities/snippets/greet.md": "Hello from the snippet.\n",
      },
      "alpha",
    );

    expect(filesUnder(deployed("claude"))).toEqual(["SKILL.md"]);
    expect(filesUnder(deployed("codex"))).toEqual(["SKILL.md", "agents/openai.yaml"]);
    const body = readFileSync(join(deployed("claude"), "SKILL.md"), "utf8");
    expect(body).toContain("Hello from the snippet.");
    expect(body).not.toContain("<!-- include:");
    expect(replan().actions).toEqual([]);
  });

  test("a payload stored as text keeps parsing, and text skills keep their hash", () => {
    const payload = StagedDeployPayloadSchema.parse({
      tasks: [
        {
          type: "skill",
          action: "add",
          key: { kind: "skill", name: "alpha" },
          target: "claude",
          sourceId: "source-a",
          contentSha: "a".repeat(64),
          renderedHash: "b".repeat(64),
          files: [
            { rel: "SKILL.md", content: "---\ndescription: a\n---\nbody\n" },
            { rel: "ref/note.md", content: "note ✓\n" },
          ],
        },
      ],
    });
    const task = payload.tasks[0];
    if (task?.type !== "skill") throw new Error("expected a skill task");
    expect(task.files.map((file) => [file.encoding, file.mode])).toEqual([
      ["utf8", 0o644],
      ["utf8", 0o644],
    ]);

    const files = task.files.map(stagedSkillFile);
    const legacyText = [...task.files]
      .sort((a, b) => a.rel.localeCompare(b.rel))
      .map((file) => `${file.rel}\n${file.content}`)
      .join("\0");
    const legacy = createHash("sha256").update(legacyText).digest("hex");
    expect(hashSkillFiles(files)).toBe(legacy);
    expect(hashSkillFiles(files.map((file) => ({ ...file, mode: 0o755 as const })))).not.toBe(
      legacy,
    );
  });
});
