// Home-resolution precedence + redirect-predicate + childEnv reconciliation
// Tests for the deploy-target port's path and environment resolution.
//
// The SAFETY INVARIANT under test: the fail-safe default is the SANDBOX. A real-
// home deploy happens only when positively proven — explicit HIVE_*_HOME env,
// packaged (devMode:false), or the allowRealHomeDeploy toggle on. Any unknown /
// ambiguous context resolves to the sandbox.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const REAL_CLAUDE = join(homedir(), ".claude");
const REAL_CODEX = join(homedir(), ".codex");
const REAL_AGENTS = join(homedir(), ".agents");
const REAL_LEDGER = join(homedir(), ".agent-kit", "manifest.json");

const HIVE_KEYS = [
  "HIVE_RUNTIME_ROOT",
  "HIVE_CLAUDE_HOME",
  "HIVE_CODEX_HOME",
  "HIVE_AGENTS_HOME",
  "HIVE_LEDGER_PATH",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(HIVE_KEYS.map((k) => [k, process.env[k]]));
  for (const k of HIVE_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of HIVE_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const packaged = () => defaultDeployTargets({ devMode: false, allowRealHomeDeploy: () => false });
const devOff = () => defaultDeployTargets({ devMode: true, allowRealHomeDeploy: () => false });
const devOn = () => defaultDeployTargets({ devMode: true, allowRealHomeDeploy: () => true });

describe("home resolution precedence", () => {
  test("explicit HIVE_CLAUDE_HOME wins over everything (even packaged)", () => {
    process.env.HIVE_CLAUDE_HOME = "/explicit/claude";
    // Packaged would otherwise resolve the real home; the explicit env still wins.
    expect(packaged().claudeHome()).toBe("/explicit/claude");
    expect(devOn().claudeHome()).toBe("/explicit/claude");
    expect(devOff().claudeHome()).toBe("/explicit/claude");
  });

  test("devMode:false (packaged) ⇒ real ~/.claude", () => {
    expect(packaged().claudeHome()).toBe(REAL_CLAUDE);
    expect(packaged().codexHome()).toBe(REAL_CODEX);
    expect(packaged().agentsHome()).toBe(REAL_AGENTS);
    expect(packaged().ledgerPath()).toBe(REAL_LEDGER);
  });

  test("devMode:true + allowRealHomeDeploy:false ⇒ <HIVE_RUNTIME_ROOT>/homes/.claude", () => {
    process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-7";
    const t = devOff();
    const sandbox = join("/tmp/hive-7", "homes");
    expect(t.claudeHome()).toBe(join(sandbox, ".claude"));
    expect(t.codexHome()).toBe(join(sandbox, ".codex"));
    expect(t.agentsHome()).toBe(join(sandbox, ".agents"));
    expect(t.ledgerPath()).toBe(join(sandbox, ".agent-kit", "manifest.json"));
  });

  test("devMode:true + allowRealHomeDeploy:true ⇒ real ~/.claude", () => {
    process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-7";
    expect(devOn().claudeHome()).toBe(REAL_CLAUDE);
    expect(devOn().codexHome()).toBe(REAL_CODEX);
    expect(devOn().agentsHome()).toBe(REAL_AGENTS);
  });

  test("the toggle is read at CALL time, not snapshotted", () => {
    process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-7";
    let allow = false;
    const t = defaultDeployTargets({ devMode: true, allowRealHomeDeploy: () => allow });
    expect(t.claudeHome()).toBe(join("/tmp/hive-7", "homes", ".claude"));
    allow = true;
    expect(t.claudeHome()).toBe(REAL_CLAUDE);
  });
});

describe("fail-safe default", () => {
  test("UNKNOWN context (no packaged marker, no toggle) ⇒ sandbox, not real home", () => {
    process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-bare";
    const t = devOff();
    expect(t.claudeHome()).toBe(join("/tmp/hive-bare", "homes", ".claude"));
    expect(t.claudeHome()).not.toBe(REAL_CLAUDE);
  });
});

describe("childEnv sandbox reconciliation (B2a)", () => {
  test("dev-sandbox HOME/USERPROFILE + CLAUDE_CONFIG_DIR resolve so ~/.claude|.codex|.agents equal the sandbox homes", () => {
    process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-9";
    const t = devOff();
    const env = t.childEnv({ HOME: "/real/home", USERPROFILE: "C:\\real\\home" });
    const sandboxParent = join("/tmp/hive-9", "homes");

    // CLAUDE_CONFIG_DIR pins claude directly.
    expect(env.CLAUDE_CONFIG_DIR).toBe(t.claudeHome());
    // $HOME points at the sandbox parent so an installer resolving ~/.codex,
    // ~/.agents from $HOME lands on the SAME tree the deploy engine writes.
    expect(env.HOME).toBe(sandboxParent);
    expect(env.USERPROFILE).toBe(sandboxParent);
    // The B2a invariant: installer-resolved ~/.codec|.agents == resolved homes.
    expect(join(env.HOME ?? "", ".codex")).toBe(t.codexHome());
    expect(join(env.HOME ?? "", ".agents")).toBe(t.agentsHome());
    expect(join(env.CLAUDE_CONFIG_DIR ?? "")).toBe(t.claudeHome());
  });

  test("packaged (real homes) leaves $HOME intact", () => {
    const t = packaged();
    const env = t.childEnv({ HOME: "/real/home", USERPROFILE: "C:\\real\\home" });
    expect(env.HOME).toBe("/real/home");
    expect(env.USERPROFILE).toBe("C:\\real\\home");
    expect(env.CLAUDE_CONFIG_DIR).toBe(REAL_CLAUDE);
  });
});

describe("redirected predicate (B3) — honest, resolved-home, normalized", () => {
  test("dev sandbox ⇒ true (all homes off-real)", () => {
    process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-r";
    expect(devOff().isChildEnvRedirected()).toBe(true);
  });

  test("full redirectHomeEnv (all three HIVE_*_HOME) ⇒ true", () => {
    process.env.HIVE_CLAUDE_HOME = "/tmp/r/claude";
    process.env.HIVE_CODEX_HOME = "/tmp/r/codex";
    process.env.HIVE_AGENTS_HOME = "/tmp/r/agents";
    // Even packaged: all three resolve off-real because explicit env wins.
    expect(packaged().isChildEnvRedirected()).toBe(true);
  });

  test("only HIVE_RUNTIME_ROOT with real homes (packaged) ⇒ false", () => {
    process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-r";
    // Packaged → homes resolve real; RUNTIME_ROOT alone does NOT make it redirected.
    expect(packaged().isChildEnvRedirected()).toBe(false);
  });

  test("partial subset (only one HIVE_*_HOME) with real others ⇒ false", () => {
    process.env.HIVE_CLAUDE_HOME = "/tmp/r/claude";
    // codex + agents resolve real (packaged) → not every home is off-real → false.
    expect(packaged().isChildEnvRedirected()).toBe(false);
  });

  test("normalized compare tolerates case / separator / trailing slash", () => {
    // Point claude at the real home but with a trailing slash and different case
    // + separators; the normalized compare should still see it as REAL → with all
    // homes real (packaged), redirected is false.
    const messyReal = `${REAL_CLAUDE.replace(/\\/g, "/").toUpperCase()}/`;
    process.env.HIVE_CLAUDE_HOME = messyReal;
    process.env.HIVE_CODEX_HOME = REAL_CODEX;
    process.env.HIVE_AGENTS_HOME = REAL_AGENTS;
    expect(packaged().isChildEnvRedirected()).toBe(false);
  });
});

// Smoke: the sandbox parent is the dirname of the resolved claude home, so the
// $HOME-rewrite target (dirname(claudeHome())) and the sandbox root agree.
test("sandbox parent equals dirname of resolved claude home", () => {
  process.env.HIVE_RUNTIME_ROOT = "/tmp/hive-z";
  const t = devOff();
  expect(dirname(t.claudeHome())).toBe(join("/tmp/hive-z", "homes"));
});

// Guard the B2a invariant for the EXPLICIT-env redirect path (redirectHomeEnv),
// not just the dev-sandbox path. The helper's dotted-sibling layout must keep
// installer-resolved ~/.codex|.agents equal to the resolved homes, or the deploy
// engine and a shelled-out installer would write different trees.
describe("childEnv reconciliation under redirectHomeEnv (explicit env)", () => {
  test("$HOME-resolved ~/.claude|.codex|.agents equal the resolved homes", () => {
    const homes = redirectHomeEnv("/tmp/hive-redir");
    try {
      // Explicit env wins regardless of devMode/toggle; use packaged to prove the
      // env still wins.
      const t = packaged();
      expect(t.claudeHome()).toBe(homes.claudeHome);
      expect(t.codexHome()).toBe(homes.codexHome);
      expect(t.agentsHome()).toBe(homes.agentsHome);
      expect(t.isChildEnvRedirected()).toBe(true);

      const env = t.childEnv({ HOME: "/real/home" });
      const childHome = env.HOME ?? "";
      // All three homes are dotted siblings of $HOME, so an installer resolving
      // ~/.claude|.codex|.agents from $HOME lands on each resolved home. Compare
      // by the shared parent + dotted basename (separator-agnostic — the helper
      // uses forward slashes, join() would introduce backslashes on Windows).
      expect(dirname(t.claudeHome())).toBe(childHome);
      expect(dirname(t.codexHome())).toBe(childHome);
      expect(dirname(t.agentsHome())).toBe(childHome);
      expect(t.claudeHome().endsWith("/.claude")).toBe(true);
      expect(t.codexHome().endsWith("/.codex")).toBe(true);
      expect(t.agentsHome().endsWith("/.agents")).toBe(true);
    } finally {
      clearHomeEnv();
    }
  });
});
