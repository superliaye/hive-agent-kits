// Deploy-target port — the safety boundary for the deploy engine.
//
// The Kit module never reads `~/.claude` from a bare global; it resolves every
// CLI-home path through this consumer-owned port. Each home is env-overridable
// (HIVE_CLAUDE_HOME / HIVE_CODEX_HOME / HIVE_AGENTS_HOME / HIVE_LEDGER_PATH /
// HIVE_RUNTIME_ROOT) so a test can point the whole deploy at a redirected temp
// home and the real `~/.claude` is never touched.
//
// CRITICAL second responsibility: produce the REDIRECTED CHILD-PROCESS ENV for
// every external exec (`claude`/`git`/`npx`/`./setup`). Those tools resolve
// THEIR config from CLAUDE_CONFIG_DIR / $HOME / $USERPROFILE — NOT from HIVE_*.
// Without redirecting those, a plugin/bundle deploy would hit the real
// `~/.claude` even under test. `childEnv()` overrides them to the redirected
// home, and `isChildEnvRedirected()` lets the exec adapter refuse to run a real
// installer unless redirection is in place (or an AGENT_KIT_SKIP_* hatch is set).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeployTarget } from "@hive/contract";
import { bundledStarterRoot } from "./bundled-starter.ts";

// `DeployTarget` (claude | codex) is the canonical wire enum in @hive/contract —
// distinct from the AgentBackend enum (claude-code | codex). Re-exported here so
// kit-internal modules keep importing it alongside the deploy-target port.
export type { DeployTarget };

export type DeployTargets = {
  claudeHome(): string;
  codexHome(): string;
  agentsHome(): string;
  ledgerPath(): string;
  // Per-Source mirror root, keyed by the opaque Source id
  // (<hiveHome>/kit/mirrors/<sourceId>). Each active Source gets its own Mirror;
  // there is no single-kit mirror anymore.
  mirrorRoot(sourceId: string): string;
  // Hive-PRIVATE integrity fingerprint sidecar (<hiveHome>/kit/fingerprints.json).
  // Distinct from the ledger — the ledger is the fixed agent-kit interop schema
  // and cannot carry Hive deploy-time hashes; this is where they live instead.
  fingerprintPath(): string;
  // Hive-private durable applied/attempt state. This is intentionally separate
  // from the byte-compatible agent-kit ledger.
  deploymentStatePath(): string;
  // Working temp dir for sync extraction (under the Hive home, swept on start).
  kitTmpRoot(): string;
  // Content root of the bundled Starter Source — the in-repo package dir whose
  // `capabilities/` + `presets/` the local Sync copies into the Starter's Mirror.
  // Env-overridable (HIVE_STARTER_ROOT): dev → the workspace package dir, shipped
  // → the packaged resources dir. A consumer-owned member of this port (not a
  // sibling), since the sync dispatch already holds `targets`.
  starterRoot(): string;
  // Redirected child-process env for an external exec. Folds CLAUDE_CONFIG_DIR /
  // HOME / USERPROFILE / npm prefix onto the resolved homes so the shelled-out
  // installer writes under the redirected home, not the real one.
  childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  // True iff `childEnv` actually redirects away from the OS-default home — the
  // guard the exec adapter checks before running a real installer.
  isChildEnvRedirected(): boolean;
};

function envOr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

// Options governing where a deploy lands. `devMode` is the packaging signal: the
// packaged launch sets HIVE_PACKAGED=1, so an unknown / hand-run daemon is
// `devMode:true` and resolves the SANDBOX (the fail-safe default). `allowRealHomeDeploy`
// is read at CALL time (the toggle can flip at runtime) — never snapshotted.
export type DeployTargetsOptions = {
  allowRealHomeDeploy: () => boolean;
  devMode: boolean;
};

// Normalize a path for a Windows-tolerant home comparison: lowercase (NTFS is
// case-insensitive), backslashes → forward slashes, and drop a trailing slash.
function normalizeHome(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Default adapter: each deploy-target home resolves through a three-step ladder:
//   1. explicit HIVE_*_HOME / HIVE_LEDGER_PATH env wins (the test redirect contract);
//   2. else if packaged OR the developer toggle is on → the real ~/.claude etc.;
//   3. else (dev + toggle off, fail-safe) → a per-instance sandbox under
//      <hiveHome>/homes/ using DOTTED dir names so an installer subprocess that
//      resolves ~/.claude from $HOME lands on the same tree (see childEnv, B2a).
// Only the four deploy-target homes follow this ladder; the shared onboard paths
// (mirrorRoot/fingerprintPath/kitTmpRoot/starterRoot) stay hiveHome()-derived.
// Fail-safe default port: dev mode, toggle off → the per-instance sandbox. The
// safe construction for a caller with no Config to read (the Kit module's
// no-targets fallback, and tests that rely on explicit HIVE_*_HOME env, where the
// env wins regardless of these options).
export function failSafeDeployTargets(): DeployTargets {
  return defaultDeployTargets({ devMode: true, allowRealHomeDeploy: () => false });
}

export function defaultDeployTargets(opts: DeployTargetsOptions): DeployTargets {
  const hiveHome = () => envOr("HIVE_RUNTIME_ROOT", join(homedir(), ".hive"));
  // Real OS-default homes — the production deploy targets, and the reference the
  // redirected predicate compares against.
  const realClaudeHome = () => join(homedir(), ".claude");
  const realCodexHome = () => join(homedir(), ".codex");
  const realAgentsHome = () => join(homedir(), ".agents");
  const realLedgerPath = () => join(homedir(), ".agent-kit", "manifest.json");
  // The sandbox parent; the installer's $HOME points here (B2a).
  const sandboxRoot = () => join(hiveHome(), "homes");

  // True iff a deploy should target the real home: packaged OR the toggle is on.
  // Read at call time so a runtime toggle flip takes effect on the next deploy.
  const realHome = () => !opts.devMode || opts.allowRealHomeDeploy();

  const claudeHome = () =>
    envOr("HIVE_CLAUDE_HOME", realHome() ? realClaudeHome() : join(sandboxRoot(), ".claude"));
  const codexHome = () =>
    envOr("HIVE_CODEX_HOME", realHome() ? realCodexHome() : join(sandboxRoot(), ".codex"));
  const agentsHome = () =>
    envOr("HIVE_AGENTS_HOME", realHome() ? realAgentsHome() : join(sandboxRoot(), ".agents"));
  const ledgerPath = () =>
    envOr(
      "HIVE_LEDGER_PATH",
      realHome() ? realLedgerPath() : join(sandboxRoot(), ".agent-kit", "manifest.json"),
    );

  const mirrorRoot = (sourceId: string) => join(hiveHome(), "kit", "mirrors", sourceId);
  const fingerprintPath = () => join(hiveHome(), "kit", "fingerprints.json");
  const deploymentStatePath = () => join(hiveHome(), "kit", "deployment-state.json");
  const kitTmpRoot = () => join(hiveHome(), "kit", "tmp");
  const starterRoot = () => {
    const configured = process.env.HIVE_STARTER_ROOT;
    if (configured && configured.length > 0) return configured;
    const workspace = join(
      dirname(dirname(dirname(import.meta.dir))),
      "agent-kit-starter-template",
    );
    return existsSync(join(workspace, "capabilities")) ? workspace : bundledStarterRoot(hiveHome());
  };

  // Honest redirect predicate (B3): true IFF EVERY deploy-target home resolves
  // off its real OS-default dir, normalized for Windows. This drives both the
  // exec guard (adapter.ts) and the childEnv $HOME-rewrite gate below. Computed
  // at call time because the resolved homes depend on the runtime toggle.
  const isChildEnvRedirected = () =>
    normalizeHome(claudeHome()) !== normalizeHome(realClaudeHome()) &&
    normalizeHome(codexHome()) !== normalizeHome(realCodexHome()) &&
    normalizeHome(agentsHome()) !== normalizeHome(realAgentsHome());

  return {
    claudeHome,
    codexHome,
    agentsHome,
    ledgerPath,
    mirrorRoot,
    fingerprintPath,
    deploymentStatePath,
    kitTmpRoot,
    starterRoot,
    isChildEnvRedirected,
    childEnv: (base) => {
      const env: NodeJS.ProcessEnv = { ...base };
      // Claude / its plugins resolve config from CLAUDE_CONFIG_DIR; pin it to the
      // resolved claude home (real ~/.claude in production, the sandbox/temp home
      // otherwise — the same tree the deploy engine writes).
      env.CLAUDE_CONFIG_DIR = claudeHome();
      // git / npx / ./setup resolve config from $HOME (POSIX) / $USERPROFILE
      // (Windows). When the homes are redirected off the real dir, point $HOME at
      // the resolved sandbox/temp parent so an installer writing to ~/.codex /
      // ~/.agents (no CONFIG_DIR pin) lands on the SAME tree the deploy engine
      // writes — never a split between the two. In production (real homes) we
      // leave the real $HOME intact, or installers would write into the sandbox.
      if (isChildEnvRedirected()) {
        // Point $HOME at the parent dir of the resolved claude home so an
        // installer resolving "~/.claude|.codex|.agents" lands on the resolved
        // homes. This holds IFF the three homes are DOTTED siblings of one parent
        // — true for the dev sandbox (<hiveHome>/homes/.claude) and the test
        // redirect (which uses the same dotted layout, helpers.ts). A non-dotted
        // redirect (e.g. <root>/codex) would split ~/.codex from codexHome().
        const redirectedHome = dirname(claudeHome());
        env.HOME = redirectedHome;
        env.USERPROFILE = redirectedHome;
      }
      return env;
    },
  };
}
