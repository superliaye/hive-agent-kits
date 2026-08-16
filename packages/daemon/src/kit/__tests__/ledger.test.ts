import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  emptyLedger,
  type Ledger,
  LedgerSchema,
  mergeLedger,
  ownedNamesSnapshot,
  readLedger,
  reconcilePrune,
} from "../ledger.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeLedgerFile(ledger: Ledger): void {
  const p = failSafeDeployTargets().ledgerPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(ledger, null, 2)}\n`);
}

describe("ledger", () => {
  test("(a) round-trip: mergeLedger writes a LedgerSchema-valid file with exact keys", () => {
    const targets = failSafeDeployTargets();
    const written = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["s1", "s2"],
        agents: ["a1"],
        instructions: ["core"],
        plugins: ["p1"],
        bundles: [{ name: "b1", pin: "deadbeef" }],
      },
      [],
      [],
    );

    const onDisk = JSON.parse(readFileSync(targets.ledgerPath(), "utf8"));
    const parsed = LedgerSchema.parse(onDisk);

    expect(Object.keys(parsed).sort()).toEqual(
      ["agentDefs", "agents", "bundles", "instructions", "kitVersion", "plugins", "skills"].sort(),
    );
    expect(parsed.kitVersion).toBe("1.0.0");
    expect(parsed.skills.map((e) => e.name).sort()).toEqual(["s1", "s2"]);
    expect(parsed.agentDefs.map((e) => e.name)).toEqual(["a1"]);
    expect(parsed.instructions.map((e) => e.name)).toEqual(["core"]);
    expect(parsed.plugins.map((e) => e.name)).toEqual(["p1"]);
    expect(parsed.bundles).toEqual([{ name: "b1", pin: "deadbeef" }]);
    expect(written).toEqual(parsed);
  });

  test("(b) pre-existing manifest surfaced by readLedger", () => {
    const targets = failSafeDeployTargets();
    const seed: Ledger = {
      ...emptyLedger(),
      kitVersion: "0.9.0",
      skills: [{ name: "existing" }],
      bundles: [{ name: "bun", pin: null }],
    };
    writeLedgerFile(seed);
    const read = readLedger(targets);
    expect(read).not.toBeNull();
    expect(read?.kitVersion).toBe("0.9.0");
    expect(read?.skills.map((e) => e.name)).toEqual(["existing"]);
    expect(read?.bundles).toEqual([{ name: "bun", pin: null }]);
  });

  test("(c) prune-correctness: mergeLedger drops only pruned names", () => {
    const targets = failSafeDeployTargets();
    writeLedgerFile({ ...emptyLedger(), skills: [{ name: "keep" }, { name: "drop" }] });

    const merged = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["keep"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      ["drop"], // prunedSkills
      [],
    );
    expect(merged.skills.map((e) => e.name).sort()).toEqual(["keep"]);
  });

  test("(d) concurrent external write: reconcilePrune re-reads -> X handled per fresh-ledger semantics", () => {
    const targets = failSafeDeployTargets();
    // Hive deploys skill A.
    mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["A"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    // Snapshot what Hive owns at request start — the only names this deploy may
    // prune. (The engine takes this snapshot BEFORE applying.)
    const priorOwned = ownedNamesSnapshot(targets);
    expect(priorOwned.skills).toEqual(["A"]);

    // The agent-kit CLI concurrently adds skill X to the on-disk ledger.
    const current = readLedger(targets);
    expect(current).not.toBeNull();
    if (current) {
      writeLedgerFile({ ...current, skills: [...current.skills, { name: "X" }] });
    }

    // reconcilePrune re-reads the FRESH on-disk ledger {A, X} but prunes only
    // names that were Hive-owned at request start AND are now deselected. The new
    // deploy still selects {A}, so NOTHING is prunable — crucially X (the CLI's
    // concurrent addition) is NEVER returned, because it was not in priorOwned.
    const orphan = reconcilePrune(targets, ["A"], [], priorOwned, {
      skills: new Set(["A"]),
      agents: new Set(),
    });
    expect(orphan.skills).not.toContain("X");
    expect(orphan.skills).not.toContain("A");
    expect(orphan.skills).toEqual([]);

    // The deploy passes orphan.skills (empty) as pruned -> X survives the merge.
    const merged = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["A"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      orphan.skills,
      orphan.agents,
    );
    expect(merged.skills.map((e) => e.name).sort()).toEqual(["A", "X"]);
  });

  test("(d2) reconcilePrune DOES prune a Hive-owned skill that this deploy deselects", () => {
    const targets = failSafeDeployTargets();
    // Hive owns {A, B} at request start.
    mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["A", "B"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    const priorOwned = ownedNamesSnapshot(targets);
    // The new deploy selects only {A}; B is owned-but-deselected AND still provided
    // by an active Source (in the active catalog) -> the genuine prunable orphan.
    const orphan = reconcilePrune(targets, ["A"], [], priorOwned, {
      skills: new Set(["A", "B"]),
      agents: new Set(),
    });
    expect(orphan.skills).toEqual(["B"]);
  });

  test("(d3) : reconcilePrune does NOT prune an owned-but-deselected name absent from the active catalog", () => {
    const targets = failSafeDeployTargets();
    // Hive owns {A, B} at request start.
    mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["A", "B"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    const priorOwned = ownedNamesSnapshot(targets);
    // The new deploy deselects BOTH. B is still provided by an active Source, but
    // A's Source is inactive (A absent from the active catalog). A is an ORPHAN —
    // kept (never auto-deleted); only B is prunable.
    const orphan = reconcilePrune(targets, [], [], priorOwned, {
      skills: new Set(["B"]),
      agents: new Set(),
    });
    expect(orphan.skills).toEqual(["B"]);
    expect(orphan.skills).not.toContain("A");
  });

  test("(e) plugins/bundles never auto-removed on deselect (no prune path)", () => {
    const targets = failSafeDeployTargets();
    writeLedgerFile({
      ...emptyLedger(),
      plugins: [{ name: "oldplugin" }],
      bundles: [{ name: "oldbundle", pin: "abc" }],
    });

    // A deploy that selects neither the old plugin nor the old bundle.
    const merged = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: [],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    // Both survive — mergeLedger has no prune set for plugins/bundles.
    expect(merged.plugins.map((e) => e.name)).toContain("oldplugin");
    expect(merged.bundles.map((e) => e.name)).toContain("oldbundle");
  });

  test("completes partial Ledger writes and fsyncs the containing directory", () => {
    const targets = failSafeDeployTargets();
    let writes = 0;
    let directoryFsyncs = 0;

    mergeLedger(
      targets,
      {
        kitVersion: "",
        targets: ["claude"],
        skills: ["partial"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
      [],
      {
        write: (fd, bytes, offset, length) => {
          writes += 1;
          return writeSync(fd, bytes, offset, Math.min(length, 5));
        },
        fsyncDirectory: () => {
          directoryFsyncs += 1;
        },
      },
    );

    expect(writes).toBeGreaterThan(1);
    expect(directoryFsyncs).toBe(1);
    expect(readLedger(targets)?.skills).toEqual([{ name: "partial" }]);
  });

  test("serializes a second protocol writer with Hive so both RMW updates survive", async () => {
    const targets = failSafeDeployTargets();
    writeLedgerFile({ ...emptyLedger(), skills: [{ name: "before" }] });
    const ready = join(tmpRoot, "agent-kit.ready");
    const release = join(tmpRoot, "agent-kit.release");
    const hiveDone = join(tmpRoot, "hive.done");
    const lockModule = new URL("../../lib/durable-file.ts", import.meta.url).href;
    const agentKit = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const { withCooperativeFileLock } = await import(process.env.LOCK_MODULE);
withCooperativeFileLock(process.env.LEDGER_PATH, 5000, () => {
  const current = JSON.parse(readFileSync(process.env.LEDGER_PATH, "utf8"));
  writeFileSync(process.env.READY_PATH, "ready");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(process.env.RELEASE_PATH)) Atomics.wait(wait, 0, 0, 5);
  writeFileSync(process.env.LEDGER_PATH, JSON.stringify({
    ...current,
    skills: [...current.skills, { name: "agent-kit" }],
  }, null, 2) + "\\n");
});`,
      ],
      {
        env: {
          ...process.env,
          READY_PATH: ready,
          RELEASE_PATH: release,
          LEDGER_PATH: targets.ledgerPath(),
          LOCK_MODULE: lockModule,
        },
        stderr: "pipe",
      },
    );
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
      await Bun.sleep(5);
    }
    expect(existsSync(ready)).toBe(true);
    const ledgerModule = new URL("../ledger.ts", import.meta.url).href;
    const targetsModule = new URL("../targets.ts", import.meta.url).href;
    const hive = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs";
const { mergeLedger } = await import(process.env.LEDGER_MODULE);
const { failSafeDeployTargets } = await import(process.env.TARGETS_MODULE);
mergeLedger(failSafeDeployTargets(), {
  kitVersion: "",
  targets: ["claude"],
  skills: ["hive"],
  agents: [],
  instructions: [],
  plugins: [],
  bundles: [],
}, [], [], []);
writeFileSync(process.env.HIVE_DONE_PATH, "done");`,
      ],
      {
        env: {
          ...process.env,
          LEDGER_MODULE: ledgerModule,
          TARGETS_MODULE: targetsModule,
          HIVE_DONE_PATH: hiveDone,
        },
        stderr: "pipe",
      },
    );
    await Bun.sleep(100);
    const hiveWaited = !existsSync(hiveDone);
    writeFileSync(release, "go");
    expect(await agentKit.exited).toBe(0);
    expect(await hive.exited).toBe(0);
    expect(hiveWaited).toBe(true);

    expect(
      readLedger(targets)
        ?.skills.map((entry) => entry.name)
        .sort(),
    ).toEqual(["agent-kit", "before", "hive"]);
  });

  test("recovers the cooperative Ledger lock after its owner process crashes", async () => {
    const targets = failSafeDeployTargets();
    writeLedgerFile({ ...emptyLedger(), skills: [{ name: "before" }] });
    const ready = join(tmpRoot, "crashed-lock.ready");
    const lockModule = new URL("../../lib/durable-file.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs";
const { withCooperativeFileLock } = await import(process.env.LOCK_MODULE);
withCooperativeFileLock(process.env.LEDGER_PATH, 5000, () => {
  writeFileSync(process.env.READY_PATH, "ready");
  process.kill(process.pid, "SIGKILL");
});`,
      ],
      {
        env: {
          ...process.env,
          LOCK_MODULE: lockModule,
          LEDGER_PATH: targets.ledgerPath(),
          READY_PATH: ready,
        },
        stderr: "pipe",
      },
    );
    await child.exited;
    expect(existsSync(ready)).toBe(true);
    expect(existsSync(`${targets.ledgerPath()}.lock`)).toBe(true);

    const merged = mergeLedger(
      targets,
      {
        kitVersion: "",
        targets: ["claude"],
        skills: ["recovered"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
      [],
    );

    expect(merged.skills.map((entry) => entry.name).sort()).toEqual(["before", "recovered"]);
    expect(existsSync(`${targets.ledgerPath()}.lock`)).toBe(false);
  });

  test("does not steal a live Ledger lock while its synchronous owner is blocked past stale", async () => {
    const targets = failSafeDeployTargets();
    writeLedgerFile({ ...emptyLedger(), skills: [{ name: "before" }] });
    const ready = join(tmpRoot, "blocked-owner.ready");
    const done = join(tmpRoot, "blocked-writer.done");
    const lockModule = new URL("../../lib/durable-file.ts", import.meta.url).href;
    const ledgerModule = new URL("../ledger.ts", import.meta.url).href;
    const targetsModule = new URL("../targets.ts", import.meta.url).href;
    const owner = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs";
const { withCooperativeFileLock } = await import(process.env.LOCK_MODULE);
withCooperativeFileLock(process.env.LEDGER_PATH, 5000, () => {
  writeFileSync(process.env.READY_PATH, "ready");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, 4000);
}, { staleMs: 2000, updateMs: 500 });`,
      ],
      {
        env: {
          ...process.env,
          LOCK_MODULE: lockModule,
          LEDGER_PATH: targets.ledgerPath(),
          READY_PATH: ready,
        },
        stderr: "pipe",
      },
    );
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(ready)).toBe(true);
    const heartbeatBefore = statSync(`${targets.ledgerPath()}.lock`).mtimeMs;

    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs";
const { mergeLedger } = await import(process.env.LEDGER_MODULE);
const { failSafeDeployTargets } = await import(process.env.TARGETS_MODULE);
mergeLedger(failSafeDeployTargets(), {
  kitVersion: "",
  targets: ["claude"],
  skills: ["waited"],
  agents: [],
  instructions: [],
  plugins: [],
  bundles: [],
}, [], [], [], { lockStaleMs: 2000, lockUpdateMs: 500 });
writeFileSync(process.env.DONE_PATH, "done");`,
      ],
      {
        env: {
          ...process.env,
          LEDGER_MODULE: ledgerModule,
          TARGETS_MODULE: targetsModule,
          DONE_PATH: done,
        },
        stderr: "pipe",
      },
    );
    await Bun.sleep(3_000);
    expect(statSync(`${targets.ledgerPath()}.lock`).mtimeMs).toBeGreaterThan(heartbeatBefore);
    expect(existsSync(done)).toBe(false);
    expect(await owner.exited).toBe(0);
    expect(await writer.exited).toBe(0);
    expect(
      readLedger(targets)
        ?.skills.map((entry) => entry.name)
        .sort(),
    ).toEqual(["before", "waited"]);
  }, 10_000);

  test("keeps a live Ledger owner exclusive and releases safely after its keeper crashes", async () => {
    const targets = failSafeDeployTargets();
    writeLedgerFile({ ...emptyLedger(), skills: [{ name: "before" }] });
    const ready = join(tmpRoot, "keeper-crash-owner.ready");
    const done = join(tmpRoot, "keeper-crash-writer.done");
    const lockModule = new URL("../../lib/durable-file.ts", import.meta.url).href;
    const ledgerModule = new URL("../ledger.ts", import.meta.url).href;
    const targetsModule = new URL("../targets.ts", import.meta.url).href;
    const owner = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs";
const { withCooperativeFileLock } = await import(process.env.LOCK_MODULE);
withCooperativeFileLock(process.env.LEDGER_PATH, 5000, () => {
  writeFileSync(process.env.READY_PATH, "ready");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, 3200);
});`,
      ],
      {
        env: {
          ...process.env,
          LOCK_MODULE: lockModule,
          LEDGER_PATH: targets.ledgerPath(),
          READY_PATH: ready,
        },
        stderr: "pipe",
      },
    );
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(ready)).toBe(true);
    const metadata = JSON.parse(
      readFileSync(`${targets.ledgerPath()}.lock/owner.json`, "utf8"),
    ) as { keeper: { pid: number } };
    process.kill(metadata.keeper.pid, "SIGKILL");

    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs";
const { mergeLedger } = await import(process.env.LEDGER_MODULE);
const { failSafeDeployTargets } = await import(process.env.TARGETS_MODULE);
mergeLedger(failSafeDeployTargets(), {
  kitVersion: "",
  targets: ["claude"],
  skills: ["after-keeper-crash"],
  agents: [],
  instructions: [],
  plugins: [],
  bundles: [],
}, [], [], []);
writeFileSync(process.env.DONE_PATH, "done");`,
      ],
      {
        env: {
          ...process.env,
          LEDGER_MODULE: ledgerModule,
          TARGETS_MODULE: targetsModule,
          DONE_PATH: done,
        },
        stderr: "pipe",
      },
    );
    await Bun.sleep(2_300);
    expect(existsSync(done)).toBe(false);
    expect(await owner.exited).toBe(0);
    expect(await writer.exited).toBe(0);
    expect(
      readLedger(targets)
        ?.skills.map((entry) => entry.name)
        .sort(),
    ).toEqual(["after-keeper-crash", "before"]);
    expect(existsSync(`${targets.ledgerPath()}.lock`)).toBe(false);
  }, 10_000);

  test("retains committed Ledger bytes when replacement crashes before rename", () => {
    const targets = failSafeDeployTargets();
    writeLedgerFile({ ...emptyLedger(), skills: [{ name: "committed" }] });
    const before = readFileSync(targets.ledgerPath(), "utf8");

    expect(() =>
      mergeLedger(
        targets,
        {
          kitVersion: "",
          targets: ["claude"],
          skills: ["uncommitted"],
          agents: [],
          instructions: [],
          plugins: [],
          bundles: [],
        },
        [],
        [],
        [],
        {
          rename: () => {
            throw new Error("crash before rename");
          },
        },
      ),
    ).toThrow("crash before rename");
    expect(readFileSync(targets.ledgerPath(), "utf8")).toBe(before);
  });
});
