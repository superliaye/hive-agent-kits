// Deploy engine orchestrator (Plan A4) — ordered best-effort apply.
//
// Pre-flight binaries for SELECTED kinds only, abort BEFORE any write on a
// missing tool (typed DeployError naming it). Apply kinds in order, collect a
// per-kind result, write the Ledger to reflect what ACTUALLY landed. Reconcile
// prunes owned-but-deselected skills/agents (re-reading the ledger). Plugins/
// bundles are hint-only on deselect. Re-deploy is idempotent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityKind, DeployResult, KindResult } from "@hive/contract";
import { Effect } from "effect";
import { log } from "../../lib/log.ts";
import { DeployError } from "../effect/errors.ts";
import { recordFingerprints } from "../fingerprint.ts";
import {
  type Ledger,
  mergeLedger,
  ownedNamesSnapshot,
  readLedger,
  reconcilePrune,
} from "../ledger.ts";
import type { ResolvedSelection } from "../selection.ts";
import type { DeployTarget, DeployTargets } from "../targets.ts";
import {
  backupIfExists,
  type DeployFsExec,
  execInstaller,
  probeBinary,
  readSkillSource,
  removeDir,
  removeFile,
  writeFileAt,
  writeSkillFolder,
} from "./adapter.ts";
import { deployedAgentPath, deployedInstructionPath, deployedSkillDir } from "./artifact-hash.ts";
import {
  agentSourceDir,
  bundleMeta,
  instructionBody,
  loadSnippets,
  pluginMeta,
  skillDisablesModelInvocation,
  skillSourceDir,
} from "./sources.ts";
import { transformAgent, transformInstructions, transformSkill } from "./transforms.ts";

// Skip-env hatches (honored exactly as upstream).
const skipBundle = (): boolean => process.env.AGENT_KIT_SKIP_BUNDLE_INSTALL === "1";
const skipPlugin = (): boolean => process.env.AGENT_KIT_SKIP_PLUGIN_INSTALL === "1";

function emptyKind(kind: CapabilityKind): KindResult {
  return { kind, applied: [], failed: [] };
}

// Pre-flight: which binaries does this selection require, and are they present?
// claude iff a plugin; git iff a setup-script bundle; npx iff an npx-skills
// bundle. A missing tool is a typed DeployError BEFORE any write.
function preflight(fx: DeployFsExec, sel: ResolvedSelection): DeployError | null {
  const needs: { tool: string; reason: string }[] = [];
  if (sel.plugins.length > 0 && sel.targets.includes("claude") && !skipPlugin()) {
    needs.push({ tool: "claude", reason: "plugin install" });
  }
  if (!skipBundle()) {
    for (const item of sel.bundles) {
      const meta = bundleMeta(fx.targets.mirrorRoot(item.sourceId), item.name);
      if (!meta) continue;
      if (meta.installerKind === "setup-script")
        needs.push({ tool: "git", reason: `bundle ${item.name}` });
      else needs.push({ tool: "npx", reason: `bundle ${item.name}` });
    }
  }
  for (const n of needs) {
    if (!probeBinary(fx, n.tool)) {
      return new DeployError({
        reason: "missing_binary",
        message: `${n.tool} is required for ${n.reason} but is not on PATH`,
        tool: n.tool,
      });
    }
  }
  return null;
}

// ---- per-kind apply ----

function applyInstructions(fx: DeployFsExec, sel: ResolvedSelection): KindResult {
  const res = emptyKind("instruction");
  const bodies: string[] = [];
  const resolvedNames: string[] = [];
  // Each instruction concatenates from ITS OWN winner Mirror — different
  // instructions in one selection may be won by different Sources. Order stays the
  // resolved-array order (deterministic, identical to the diff path).
  for (const item of sel.instructions) {
    const body = instructionBody(fx.targets.mirrorRoot(item.sourceId), item.name);
    if (body === null) {
      res.failed.push({ name: item.name, error: "source not found in mirror" });
      continue;
    }
    bodies.push(body);
    resolvedNames.push(item.name);
  }
  const compiled = transformInstructions(bodies);
  // The whole-file write is the unit of success — only mark the names applied
  // once every selected target's file landed. A write fault (EACCES/EROFS) is
  // captured as a per-kind failure, never an untyped defect escaping to a 500.
  try {
    if (sel.targets.includes("claude")) {
      const claudeMd = deployedInstructionPath(fx.targets, "claude");
      backupIfExists(claudeMd);
      writeFileAt(claudeMd, compiled);
    }
    if (sel.targets.includes("codex")) {
      const agentsMd = deployedInstructionPath(fx.targets, "codex");
      backupIfExists(agentsMd);
      writeFileAt(agentsMd, compiled);
    }
    res.applied.push(...resolvedNames);
  } catch (err) {
    for (const name of resolvedNames) res.failed.push({ name, error: String(err) });
  }
  return res;
}

function applySkills(
  fx: DeployFsExec,
  sel: ResolvedSelection,
  snippets: Map<string, string>,
): KindResult {
  const res = emptyKind("skill");
  for (const item of sel.skills) {
    const srcDir = skillSourceDir(fx.targets.mirrorRoot(item.sourceId), item.name);
    if (!srcDir) {
      res.failed.push({ name: item.name, error: "source not found in mirror" });
      continue;
    }
    try {
      const files = readSkillSource(srcDir);
      const out = transformSkill(
        { name: item.name, files, disableModelInvocation: skillDisablesModelInvocation(srcDir) },
        snippets,
      );
      for (const target of sel.targets) {
        const skillsDir = deployedSkillDir(fx.targets, item.name, target);
        const allFiles =
          out.sidecar && target === "codex" ? [...out.files, out.sidecar] : out.files;
        writeSkillFolder(skillsDir, allFiles);
      }
      res.applied.push(item.name);
    } catch (err) {
      res.failed.push({ name: item.name, error: String(err) });
    }
  }
  return res;
}

function applyAgents(
  fx: DeployFsExec,
  sel: ResolvedSelection,
  snippets: Map<string, string>,
): KindResult {
  const res = emptyKind("agent");
  for (const item of sel.agents) {
    const srcDir = agentSourceDir(fx.targets.mirrorRoot(item.sourceId), item.name);
    if (!srcDir) {
      res.failed.push({ name: item.name, error: "source not found in mirror" });
      continue;
    }
    try {
      const content = readFileSync(join(srcDir, "AGENT.md"), "utf8");
      const out = transformAgent({ name: item.name, raw: content }, snippets);
      if (sel.targets.includes("claude")) {
        writeFileAt(deployedAgentPath(fx.targets, item.name, "claude"), out.claudeMd);
      }
      if (sel.targets.includes("codex")) {
        writeFileAt(deployedAgentPath(fx.targets, item.name, "codex"), out.codexToml);
      }
      res.applied.push(item.name);
    } catch (err) {
      res.failed.push({ name: item.name, error: String(err) });
    }
  }
  return res;
}

function applyPlugins(fx: DeployFsExec, sel: ResolvedSelection): KindResult {
  const res = emptyKind("plugin");
  // Claude-only.
  if (!sel.targets.includes("claude")) return res;
  for (const item of sel.plugins) {
    const name = item.name;
    const meta = pluginMeta(fx.targets.mirrorRoot(item.sourceId), name);
    if (!meta) {
      res.failed.push({ name, error: "plugin source not found in mirror" });
      continue;
    }
    if (skipPlugin()) {
      log().warn(
        { module: "kit/deploy", plugin: name },
        "plugin install skipped (AGENT_KIT_SKIP_PLUGIN_INSTALL)",
      );
      res.applied.push(name);
      continue;
    }
    if (!meta.source || !meta.market) {
      res.failed.push({ name, error: "missing marketplace_source/marketplace_name" });
      continue;
    }
    try {
      const add = execInstaller(
        fx,
        { command: "claude", args: ["plugin", "marketplace", "add", meta.source] },
        "claude",
      );
      if (add.status !== 0) {
        res.failed.push({ name, error: `marketplace add exited ${add.status}` });
        continue;
      }
      const install = execInstaller(
        fx,
        {
          command: "claude",
          args: ["plugin", "install", `${meta.pluginName}@${meta.market}`, "--scope", "user"],
        },
        "claude",
      );
      if (install.status !== 0) {
        res.failed.push({ name, error: `plugin install exited ${install.status}` });
        continue;
      }
      res.applied.push(name);
    } catch (err) {
      // The not_redirected guard is a blast-radius safety stop — it must abort
      // the deploy, not downgrade to a per-plugin failure.
      if (err instanceof DeployError && err.reason === "not_redirected") throw err;
      res.failed.push({ name, error: String(err) });
    }
  }
  return res;
}

function applyBundles(
  fx: DeployFsExec,
  sel: ResolvedSelection,
): { result: KindResult; pins: Record<string, string | null> } {
  const res = emptyKind("bundle");
  const pins: Record<string, string | null> = {};
  for (const item of sel.bundles) {
    const name = item.name;
    const meta = bundleMeta(fx.targets.mirrorRoot(item.sourceId), name);
    if (!meta) {
      res.failed.push({ name, error: "bundle source not found in mirror" });
      continue;
    }
    const pin = meta.installerKind === "npx-skills" ? meta.pkg : meta.pinnedCommit;
    if (skipBundle()) {
      log().warn(
        { module: "kit/deploy", bundle: name },
        "bundle install skipped (AGENT_KIT_SKIP_BUNDLE_INSTALL)",
      );
      pins[name] = pin || null;
      res.applied.push(name);
      continue;
    }
    try {
      if (meta.installerKind === "npx-skills") {
        let allOk = true;
        for (const target of sel.targets) {
          const cliAgent = target === "claude" ? "claude-code" : "codex";
          const r = execInstaller(
            fx,
            {
              command: "npx",
              args: [
                "-y",
                "skills",
                "add",
                meta.pkg,
                "--global",
                "--agent",
                cliAgent,
                "--skill",
                "*",
                "--yes",
              ],
            },
            "npx",
          );
          if (r.status !== 0) allOk = false;
        }
        if (allOk) {
          pins[name] = pin || null;
          res.applied.push(name);
        } else {
          res.failed.push({ name, error: "npx skills add failed for a target" });
        }
      } else {
        // setup-script: clone is delegated to the installer; we run the
        // declared command per target with host flags through the redirected env.
        let allOk = true;
        for (const target of sel.targets) {
          const hostFlags = meta.hostFlagMap[target] ?? [];
          const r = execInstaller(
            fx,
            { command: "bash", args: [meta.command, ...meta.flags, ...hostFlags] },
            "git",
          );
          if (r.status !== 0) allOk = false;
        }
        if (allOk) {
          pins[name] = pin || null;
          res.applied.push(name);
        } else {
          res.failed.push({ name, error: "setup-script installer failed for a target" });
        }
      }
    } catch (err) {
      if (err instanceof DeployError && err.reason === "not_redirected") throw err;
      res.failed.push({ name, error: String(err) });
    }
  }
  return { result: res, pins };
}

// ---- prune (owned-but-deselected skills/agents) ----

function pruneOrphans(
  fx: DeployFsExec,
  pruneSkills: string[],
  pruneAgents: string[],
  targets: DeployTarget[],
): { kind: CapabilityKind; name: string }[] {
  const pruned: { kind: CapabilityKind; name: string }[] = [];
  for (const name of pruneSkills) {
    for (const target of targets) {
      removeDir(deployedSkillDir(fx.targets, name, target));
    }
    pruned.push({ kind: "skill", name });
  }
  for (const name of pruneAgents) {
    if (targets.includes("claude")) removeFile(deployedAgentPath(fx.targets, name, "claude"));
    if (targets.includes("codex")) removeFile(deployedAgentPath(fx.targets, name, "codex"));
    pruned.push({ kind: "agent", name });
  }
  return pruned;
}

// ---- public verb ----

export type DeployInput = {
  selection: ResolvedSelection;
  kitSha: string | null;
  kitVersion: string;
  // Active-Source mirror roots, in registry order — used ONLY for snippet loading
  // (snippets aren't Capabilities, so they have no winner). Each Capability's
  // winner Mirror travels in `selection` (the resolved item's sourceId).
  activeMirrorRoots: readonly string[];
};

export function runDeploy(
  fx: DeployFsExec,
  input: DeployInput,
): Effect.Effect<DeployResult, DeployError> {
  return Effect.gen(function* () {
    const sel = input.selection;

    // Load snippets once, up front: a cross-Source snippet collision is a typed
    // DeployError that must ABORT the deploy (snippets aren't capabilities, so the
    // catalog's CapabilityKey guard never covered them) — never a swallowed
    // per-kind failure. Surfaced before any write.
    const snippets = yield* Effect.try({
      try: () => loadSnippets(input.activeMirrorRoots),
      catch: (err) =>
        err instanceof DeployError
          ? err
          : new DeployError({ reason: "io", message: `snippet load failed: ${String(err)}` }),
    });

    // Snapshot the names Hive owns BEFORE applying — the only names this deploy
    // is allowed to prune. A skill the agent-kit CLI adds concurrently is not in
    // this snapshot, so reconcile can never clobber it (A3 two-writer guard).
    const priorOwned = ownedNamesSnapshot(fx.targets);

    // Pre-flight binaries BEFORE any write.
    const missing = preflight(fx, sel);
    if (missing) return yield* Effect.fail(missing);

    const perKind: KindResult[] = [];

    // Ordered best-effort: instructions, skills, agents, plugins, bundles.
    perKind.push(applyInstructions(fx, sel));
    perKind.push(applySkills(fx, sel, snippets));
    perKind.push(applyAgents(fx, sel, snippets));

    let pluginResult: KindResult;
    let bundlePins: Record<string, string | null> = {};
    let bundleResult: KindResult;
    try {
      pluginResult = applyPlugins(fx, sel);
    } catch (err) {
      // A not_redirected guard throw aborts the deploy (it's a real safety stop).
      if (err instanceof DeployError && err.reason === "not_redirected") {
        return yield* Effect.fail(err);
      }
      pluginResult = { kind: "plugin", applied: [], failed: [{ name: "*", error: String(err) }] };
    }
    perKind.push(pluginResult);

    try {
      const b = applyBundles(fx, sel);
      bundleResult = b.result;
      bundlePins = b.pins;
    } catch (err) {
      if (err instanceof DeployError && err.reason === "not_redirected") {
        return yield* Effect.fail(err);
      }
      bundleResult = { kind: "bundle", applied: [], failed: [{ name: "*", error: String(err) }] };
    }
    perKind.push(bundleResult);

    // Reconcile: re-read the ledger NOW, prune only names that were Hive-owned at
    // request start AND are now deselected — never a concurrently-CLI-added name.
    const orphan = reconcilePrune(
      fx.targets,
      sel.skills.map((i) => i.name),
      sel.agents.map((i) => i.name),
      priorOwned,
    );
    const pruned = pruneOrphans(fx, orphan.skills, orphan.agents, sel.targets);

    // Plugins/bundles are never auto-removed: hint when one is owned-but-deselected.
    const bundleHint = deselectedBundleHint(
      fx.targets,
      sel.bundles.map((i) => i.name),
    );
    if (bundleHint.length > 0) bundleResult.pruneHint = bundleHint;
    const pluginHint = deselectedPluginHint(
      fx.targets,
      sel.plugins.map((i) => i.name),
    );
    if (pluginHint.length > 0) pluginResult.pruneHint = pluginHint;

    // Winner SourceId per landed skill/agent — provenance for the fingerprint
    // sidecar. A landed name is in the resolved selection, so the lookup hits.
    const skillWinner = new Map(sel.skills.map((i) => [i.name, i.sourceId]));
    const agentWinner = new Map(sel.agents.map((i) => [i.name, i.sourceId]));
    const landedWithWinner = (names: string[], winner: Map<string, string>) =>
      names.map((name) => ({ name, sourceId: winner.get(name) ?? "" }));

    // Write the ledger to reflect what ACTUALLY landed (applied lists), merging
    // concurrent external writes and dropping only the freshly-confirmed orphans.
    mergeLedger(
      fx.targets,
      {
        kitVersion: input.kitVersion,
        targets: sel.targets,
        skills: skillResultApplied(perKind),
        agents: agentResultApplied(perKind),
        instructions: instructionResultApplied(perKind),
        plugins: pluginResult.applied,
        bundles: bundleResult.applied.map((name) => ({ name, pin: bundlePins[name] ?? null })),
      },
      orphan.skills,
      orphan.agents,
    );

    // Record integrity fingerprints for EXACTLY what landed (hashing the on-disk
    // artifact deploy just wrote), pruning deselected names in lockstep with the
    // ledger prune. Hive-private sidecar — never touches the ledger schema. This
    // is best-effort metadata AFTER the deploy already landed on disk + ledger; a
    // fault here must degrade to a trace warning, never fail the whole deploy.
    yield* Effect.sync(() => {
      try {
        recordFingerprints(
          fx.targets,
          {
            skills: landedWithWinner(skillResultApplied(perKind), skillWinner),
            agents: landedWithWinner(agentResultApplied(perKind), agentWinner),
            instructions: instructionResultApplied(perKind),
            targets: sel.targets,
          },
          orphan.skills,
          orphan.agents,
          Date.now(),
        );
      } catch (err) {
        log().warn({ module: "kit/deploy", err: String(err) }, "fingerprint recording failed");
      }
    });

    return {
      kitSha: input.kitSha,
      perKind,
      pruned,
      targets: sel.targets,
    };
  });
}

function applied(perKind: KindResult[], kind: CapabilityKind): string[] {
  return perKind.find((k) => k.kind === kind)?.applied ?? [];
}
const skillResultApplied = (p: KindResult[]) => applied(p, "skill");
const agentResultApplied = (p: KindResult[]) => applied(p, "agent");
const instructionResultApplied = (p: KindResult[]) => applied(p, "instruction");

function deselectedBundleHint(targets: DeployTargets, selected: string[]): string[] {
  const ledger: Ledger | null = readLedger(targets);
  if (!ledger) return [];
  const keep = new Set(selected);
  return ledger.bundles
    .map((b) => b.name)
    .filter((n) => !keep.has(n))
    .map((n) => `bundle '${n}' deselected — not auto-removed; remove manually if desired`);
}

function deselectedPluginHint(targets: DeployTargets, selected: string[]): string[] {
  const ledger: Ledger | null = readLedger(targets);
  if (!ledger) return [];
  const keep = new Set(selected);
  return ledger.plugins
    .map((p) => p.name)
    .filter((n) => !keep.has(n))
    .map((n) => `plugin '${n}' deselected — not auto-removed; remove manually if desired`);
}
