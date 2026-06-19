// Deploy-target port (Plan A0) — the safety boundary for the deploy engine.
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

import { homedir } from "node:os";
import { join } from "node:path";

// Per-CLI deploy target. Two values (claude | codex) — distinct from the
// AgentBackend wire enum (claude-code | codex). Routes to 3 home dirs.
export type DeployTarget = "claude" | "codex";

export type DeployTargets = {
  claudeHome(): string;
  codexHome(): string;
  agentsHome(): string;
  ledgerPath(): string;
  mirrorRoot(): string;
  // Hive-PRIVATE integrity fingerprint sidecar (<hiveHome>/kit/fingerprints.json).
  // Distinct from the ledger — the ledger is the fixed agent-kit interop schema
  // and cannot carry Hive deploy-time hashes; this is where they live instead.
  fingerprintPath(): string;
  // Working temp dir for sync extraction (under the Hive home, swept on start).
  kitTmpRoot(): string;
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

// Default adapter: ~-rooted homes, each env-overridable. The redirected child
// env points CLAUDE_CONFIG_DIR + HOME/USERPROFILE at the resolved claude/runtime
// homes. When any HIVE_*_HOME / HIVE_RUNTIME_ROOT override is set we consider the
// child env redirected (the e2e + tests always set them).
export function defaultDeployTargets(): DeployTargets {
  const claudeHome = () => envOr("HIVE_CLAUDE_HOME", join(homedir(), ".claude"));
  const codexHome = () => envOr("HIVE_CODEX_HOME", join(homedir(), ".codex"));
  const agentsHome = () => envOr("HIVE_AGENTS_HOME", join(homedir(), ".agents"));
  const ledgerPath = () =>
    envOr("HIVE_LEDGER_PATH", join(homedir(), ".agent-kit", "manifest.json"));
  const hiveHome = () => envOr("HIVE_RUNTIME_ROOT", join(homedir(), ".hive"));
  const mirrorRoot = () => join(hiveHome(), "kit", "mirror");
  const fingerprintPath = () => join(hiveHome(), "kit", "fingerprints.json");
  const kitTmpRoot = () => join(hiveHome(), "kit", "tmp");

  const redirected =
    Boolean(process.env.HIVE_CLAUDE_HOME) ||
    Boolean(process.env.HIVE_AGENTS_HOME) ||
    Boolean(process.env.HIVE_RUNTIME_ROOT);

  return {
    claudeHome,
    codexHome,
    agentsHome,
    ledgerPath,
    mirrorRoot,
    fingerprintPath,
    kitTmpRoot,
    isChildEnvRedirected: () => redirected,
    childEnv: (base) => {
      const env: NodeJS.ProcessEnv = { ...base };
      // Claude / its plugins resolve config from CLAUDE_CONFIG_DIR; pin it to the
      // resolved claude home. In production this equals the real ~/.claude (the
      // intended deploy target); under a redirected test it's the temp home.
      env.CLAUDE_CONFIG_DIR = claudeHome();
      // git / npx / ./setup resolve config from $HOME (POSIX) / $USERPROFILE
      // (Windows). Only override these when REDIRECTED (a test): point them at the
      // Hive home so an installer that writes to "~/..." stays inside the temp
      // tree. In production we must leave the real $HOME intact, or installers
      // would silently write into ~/.hive instead of the user's home.
      if (redirected) {
        const redirectedHome = hiveHome();
        env.HOME = redirectedHome;
        env.USERPROFILE = redirectedHome;
      }
      // Force public npm registry for installer subprocesses (matches the
      // upstream agent-kit behavior) unless the caller pinned one.
      if (!env.NPM_CONFIG_REGISTRY) {
        env.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/";
      }
      return env;
    },
  };
}
