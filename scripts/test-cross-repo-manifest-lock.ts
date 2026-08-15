import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pin from "./fixtures/my-agent-kits/PIN.json";

const pinnedFiles = Object.entries(pin.files).map(([path, blob]) => ({ path, blob }));

function gitBlobId(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function verifyPinnedFile(path: string, bytes: Uint8Array, expected: string): void {
  const actual = gitBlobId(bytes);
  if (actual !== expected) {
    throw new Error(
      `pinned agent-kit blob mismatch for ${path}: expected ${expected}, got ${actual}`,
    );
  }
}

function fixtureFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return files.filter((path) => path !== "PIN.json").sort();
}

function verifyFixtureInventory(root: string): void {
  const expected = pinnedFiles.map((file) => file.path).sort();
  const actual = fixtureFiles(root);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unpinned = actual.filter((path) => !expectedSet.has(path));
  throw new Error(
    `pinned agent-kit fixture inventory mismatch; missing=${missing.join(",") || "none"}; unpinned=${unpinned.join(",") || "none"}`,
  );
}

function preparePinnedAgentKit(workRoot: string): { root: string; source: string } {
  const externalRoot = process.env.MY_AGENT_KITS_ROOT;
  if (!externalRoot) {
    const fixtureRoot = fileURLToPath(new URL("fixtures/my-agent-kits", import.meta.url));
    verifyFixtureInventory(fixtureRoot);
    for (const file of pinnedFiles) {
      verifyPinnedFile(file.path, readFileSync(join(fixtureRoot, file.path)), file.blob);
    }
    return { root: fixtureRoot, source: "vendored production modules" };
  }

  const checkout = resolve(externalRoot);
  let resolvedRevision: string;
  try {
    resolvedRevision = execFileSync(
      "git",
      ["-C", checkout, "rev-parse", `${pin.revision}^{commit}`],
      { encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error(`external agent-kit checkout does not contain pinned revision ${pin.revision}`);
  }
  if (resolvedRevision !== pin.revision) {
    throw new Error(`external agent-kit resolved ${resolvedRevision}, expected ${pin.revision}`);
  }

  const materialized = join(workRoot, "agent-kit-pinned");
  for (const file of pinnedFiles) {
    const bytes = execFileSync("git", ["-C", checkout, "show", `${pin.revision}:${file.path}`], {
      maxBuffer: 2 * 1024 * 1024,
    });
    verifyPinnedFile(file.path, bytes, file.blob);
    const destination = join(materialized, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  return { root: materialized, source: `external checkout ${checkout}` };
}

const root = mkdtempSync(join(tmpdir(), "cross-repo-manifest-lock-"));
const agentKit = preparePinnedAgentKit(root);
const home = join(root, "home");
const ledgerPath = join(home, ".agent-kit", "manifest.json");
const agentManifestModule = pathToFileURL(join(agentKit.root, "lib/manifest.js")).href;
const hiveLedgerModule = new URL("../packages/daemon/src/kit/ledger.ts", import.meta.url).href;
const hiveTargetsModule = new URL("../packages/daemon/src/kit/targets.ts", import.meta.url).href;
const hiveLockModule = new URL("../packages/daemon/src/lib/durable-file.ts", import.meta.url).href;
const hiveIndependentLockModule = new URL(
  "../packages/daemon/src/lib/cooperative-file-lock.ts",
  import.meta.url,
).href;

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
    HIVE_INDEPENDENT_LOCK_MODULE: hiveIndependentLockModule,
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

function spawnNodeModule(source: string, env: NodeJS.ProcessEnv) {
  return Bun.spawn(["node", "--input-type=module", "-e", source], {
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

const criticalSection = `
function enterCritical(role, enteredPath) {
  writeFileSync(enteredPath, "entered");
  try {
    writeFileSync(process.env.CRITICAL_PATH, role, { flag: "wx" });
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    writeFileSync(process.env.OVERLAP_PATH, role);
    return;
  }
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, 1000);
  rmSync(process.env.CRITICAL_PATH, { force: true });
}`;

function seedAbandonedLock(lockPath: string): void {
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, "owner.json"),
    `${JSON.stringify({
      protocol: "agent-manifest-lock-v3",
      token: "abandoned-owner",
      owner: { pid: 2_147_483_647, start: null },
      keeper: { pid: 2_147_483_647, start: null },
      staleMs: 0,
      updateMs: 500,
    })}\n`,
  );
  utimesSync(lockPath, new Date(0), new Date(0));
}

async function assertValidatePauseRace(
  label: string,
  pausedWork: string,
  contenderWork: string,
): Promise<void> {
  const lockPath = `${ledgerPath}.lock`;
  seedAbandonedLock(lockPath);
  const recoveryPaused = join(root, `${label}-recovery.paused`);
  const resumeRecovery = join(root, `${label}-recovery.resume`);
  const critical = join(root, `${label}-critical`);
  const overlap = join(root, `${label}-overlap`);
  const pausedEntered = join(root, `${label}-paused.entered`);
  const contenderEntered = join(root, `${label}-contender.entered`);

  const pausedRecovery = spawnNodeModule(
    `import fs, { existsSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalRename = fs.renameSync;
let paused = false;
fs.renameSync = (from, to) => {
  if (!paused && from === process.env.LOCK_PATH && String(to).includes(".abandoned-")) {
    paused = true;
    writeFileSync(process.env.PAUSED_PATH, "paused");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(process.env.RESUME_PATH)) Atomics.wait(wait, 0, 0, 5);
  }
  return originalRename(from, to);
};
syncBuiltinESMExports();
${criticalSection}
${pausedWork}`,
    childEnv({
      LOCK_PATH: lockPath,
      PAUSED_PATH: recoveryPaused,
      RESUME_PATH: resumeRecovery,
      CRITICAL_PATH: critical,
      OVERLAP_PATH: overlap,
      ENTERED_PATH: pausedEntered,
    }),
  );
  await waitForFile(recoveryPaused);

  const newerOwner = spawnNodeModule(
    `import { rmSync, writeFileSync } from "node:fs";
${criticalSection}
${contenderWork}`,
    childEnv({
      CRITICAL_PATH: critical,
      OVERLAP_PATH: overlap,
      ENTERED_PATH: contenderEntered,
    }),
  );
  try {
    await waitForFile(contenderEntered, 500);
  } catch {
    // The ABA-safe protocol keeps this contender out until recovery resumes.
  }
  writeFileSync(resumeRecovery, "resume");
  if ((await pausedRecovery.exited) !== 0 || (await newerOwner.exited) !== 0) {
    throw new Error(`${label} validate-pause-new-owner production contenders failed`);
  }
  if (!existsSync(pausedEntered) || !existsSync(contenderEntered)) {
    throw new Error(`${label} production contenders did not both enter`);
  }
  if (existsSync(overlap)) {
    throw new Error(`${label} paused stale recovery renamed a newer owner's live lock`);
  }
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
  const recoveredExit = await recovered.exited;
  const recoveryMs = Date.now() - recoveredAt;
  if (recoveredExit !== 0 || recoveryMs >= 5_000) {
    throw new Error("production-default crash recovery exceeded the acquisition timeout");
  }

  // Moving retirement-fence publication below owner validation, or removing
  // the acquisition fence wait, makes the two production critical sections overlap.
  await assertValidatePauseRace(
    "agent-recovers-hive-acquires",
    `const { withManifestLock } = await import(process.env.AGENT_MANIFEST_MODULE);
await withManifestLock(
  () => enterCritical("agent-kit", process.env.ENTERED_PATH),
  { timeoutMs: 5000, staleMs: 0, updateMs: 500 },
);`,
    `const { withIndependentFileLock } = await import(process.env.HIVE_INDEPENDENT_LOCK_MODULE);
withIndependentFileLock(
  process.env.HIVE_LEDGER_PATH,
  () => enterCritical("hive", process.env.ENTERED_PATH),
  { timeoutMs: 5000, staleMs: 0, updateMs: 500 },
);`,
  );
  await assertValidatePauseRace(
    "hive-recovers-agent-acquires",
    `const { withIndependentFileLock } = await import(process.env.HIVE_INDEPENDENT_LOCK_MODULE);
withIndependentFileLock(
  process.env.HIVE_LEDGER_PATH,
  () => enterCritical("hive", process.env.ENTERED_PATH),
  { timeoutMs: 5000, staleMs: 0, updateMs: 500 },
);`,
    `const { withManifestLock } = await import(process.env.AGENT_MANIFEST_MODULE);
await withManifestLock(
  () => enterCritical("agent-kit", process.env.ENTERED_PATH),
  { timeoutMs: 5000, staleMs: 0, updateMs: 500 },
);`,
  );

  console.log(`cross-repo manifest skills: ${readSkills().join(", ")}`);
  console.log(`cross-repo agent-kit pin: ${pin.revision} (${agentKit.source})`);
  console.log("cross-repo blocked-live-owner: waited past stale");
  console.log(`cross-repo crash recovery ms: ${recoveryMs}`);
  console.log("cross-repo validate-pause-new-owner: no overlaps in either direction");
} finally {
  rmSync(root, { recursive: true, force: true });
}
