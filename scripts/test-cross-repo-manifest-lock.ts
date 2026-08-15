import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const agentKitRoot = process.env.MY_AGENT_KITS_ROOT;
if (!agentKitRoot) throw new Error("MY_AGENT_KITS_ROOT is required");

const root = mkdtempSync(join(tmpdir(), "cross-repo-manifest-lock-"));
const home = join(root, "home");
const ledgerPath = join(home, ".agent-kit", "manifest.json");
const agentManifestModule = pathToFileURL(resolve(agentKitRoot, "lib/manifest.js")).href;
const hiveLedgerModule = new URL("../packages/daemon/src/kit/ledger.ts", import.meta.url).href;
const hiveTargetsModule = new URL("../packages/daemon/src/kit/targets.ts", import.meta.url).href;
const hiveLockModule = new URL("../packages/daemon/src/lib/durable-file.ts", import.meta.url).href;

const initial = {
  kitVersion: "",
  agents: [],
  skills: [{ name: "before" }],
  agentDefs: [],
  instructions: [],
  plugins: [],
  bundles: [],
};

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HIVE_LEDGER_PATH: ledgerPath,
    AGENT_MANIFEST_MODULE: agentManifestModule,
    HIVE_LEDGER_MODULE: hiveLedgerModule,
    HIVE_TARGETS_MODULE: hiveTargetsModule,
    HIVE_LOCK_MODULE: hiveLockModule,
    ...extra,
  };
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function spawnModule(source: string, env: NodeJS.ProcessEnv) {
  return Bun.spawn([process.execPath, "-e", source], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
}

function readSkills(): string[] {
  const manifest = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [
    "agentDefs",
    "agents",
    "bundles",
    "instructions",
    "kitVersion",
    "plugins",
    "skills",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`manifest keys changed: ${keys.join(", ")}`);
  }
  if (!Array.isArray(manifest.skills)) throw new Error("manifest skills are invalid");
  return manifest.skills
    .map((entry) => {
      if (!entry || typeof entry !== "object" || !("name" in entry)) {
        throw new Error("manifest skill entry is invalid");
      }
      const name = entry.name;
      if (typeof name !== "string") throw new Error("manifest skill name is invalid");
      return name;
    })
    .sort();
}

mkdirSync(dirname(ledgerPath), { recursive: true });
writeFileSync(ledgerPath, `${JSON.stringify(initial, null, 2)}\n`);

try {
  const agentReady = join(root, "agent.ready");
  const hiveReady = join(root, "hive.ready");
  const go = join(root, "go");
  const agent = spawnModule(
    `import { writeFileSync, existsSync } from "node:fs";
const { commitManifest, readManifest } = await import(process.env.AGENT_MANIFEST_MODULE);
const base = readManifest();
writeFileSync(process.env.READY_PATH, "ready");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(process.env.GO_PATH)) Atomics.wait(wait, 0, 0, 5);
await commitManifest(base, { ...base, skills: [...base.skills, { name: "agent-kit" }] });`,
    childEnv({ READY_PATH: agentReady, GO_PATH: go }),
  );
  const hive = spawnModule(
    `import { writeFileSync, existsSync } from "node:fs";
const { mergeLedger } = await import(process.env.HIVE_LEDGER_MODULE);
const { failSafeDeployTargets } = await import(process.env.HIVE_TARGETS_MODULE);
writeFileSync(process.env.READY_PATH, "ready");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(process.env.GO_PATH)) Atomics.wait(wait, 0, 0, 5);
mergeLedger(failSafeDeployTargets(), {
  kitVersion: "",
  targets: ["claude"],
  skills: ["hive"],
  agents: [],
  instructions: [],
  plugins: [],
  bundles: [],
}, [], [], []);`,
    childEnv({ READY_PATH: hiveReady, GO_PATH: go }),
  );
  await Promise.all([waitForFile(agentReady), waitForFile(hiveReady)]);
  writeFileSync(go, "go");
  if ((await agent.exited) !== 0 || (await hive.exited) !== 0) {
    throw new Error("concurrent production writers failed");
  }
  const concurrentSkills = readSkills();
  if (JSON.stringify(concurrentSkills) !== JSON.stringify(["agent-kit", "before", "hive"])) {
    throw new Error(`concurrent contributions were lost: ${concurrentSkills.join(", ")}`);
  }

  const blockedReady = join(root, "blocked.ready");
  const blockedDone = join(root, "blocked.done");
  const blockedOwner = spawnModule(
    `import { writeFileSync } from "node:fs";
const { withManifestLock } = await import(process.env.AGENT_MANIFEST_MODULE);
await withManifestLock(() => {
  writeFileSync(process.env.READY_PATH, "ready");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, 3500);
});`,
    childEnv({ READY_PATH: blockedReady }),
  );
  await waitForFile(blockedReady);
  const blockedWriter = spawnModule(
    `import { writeFileSync } from "node:fs";
const { mergeLedger } = await import(process.env.HIVE_LEDGER_MODULE);
const { failSafeDeployTargets } = await import(process.env.HIVE_TARGETS_MODULE);
mergeLedger(failSafeDeployTargets(), {
  kitVersion: "",
  targets: ["claude"],
  skills: ["waited"],
  agents: [],
  instructions: [],
  plugins: [],
  bundles: [],
}, [], [], []);
writeFileSync(process.env.DONE_PATH, "done");`,
    childEnv({ DONE_PATH: blockedDone }),
  );
  await Bun.sleep(2_800);
  if (await Bun.file(blockedDone).exists()) {
    throw new Error("Hive stole the live agent-kit lock after its stale interval");
  }
  if ((await blockedOwner.exited) !== 0 || (await blockedWriter.exited) !== 0) {
    throw new Error("blocked-owner production regression failed");
  }

  const crashReady = join(root, "crash.ready");
  const crashedOwner = spawnModule(
    `import { writeFileSync } from "node:fs";
const { withCooperativeFileLock } = await import(process.env.HIVE_LOCK_MODULE);
withCooperativeFileLock(process.env.HIVE_LEDGER_PATH, 5000, () => {
  writeFileSync(process.env.READY_PATH, "ready");
  process.kill(process.pid, "SIGKILL");
});`,
    childEnv({ READY_PATH: crashReady }),
  );
  await crashedOwner.exited;
  await waitForFile(crashReady);
  const recoveredAt = Date.now();
  const recovered = spawnModule(
    `const { commitManifest, readManifest } = await import(process.env.AGENT_MANIFEST_MODULE);
const base = readManifest();
await commitManifest(base, { ...base, skills: [...base.skills, { name: "recovered" }] });`,
    childEnv(),
  );
  if ((await recovered.exited) !== 0 || Date.now() - recoveredAt >= 5_000) {
    throw new Error("production-default crash recovery exceeded the acquisition timeout");
  }

  console.log(`cross-repo manifest skills: ${readSkills().join(", ")}`);
  console.log("cross-repo blocked-live-owner: waited past stale");
  console.log(`cross-repo crash recovery ms: ${Date.now() - recoveredAt}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
