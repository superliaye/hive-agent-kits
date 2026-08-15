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
import { mirrorContentSha } from "../content-sha.ts";
import { openDeploymentStateStore } from "../deployment-state.ts";
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
import {
  deployedAgentPath,
  deployedInstructionPath,
  deployedSkillDir,
  hashDeployedAgent,
  hashDeployedInstruction,
  hashDeployedSkill,
} from "./artifact-hash.ts";
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

type TargetOutcome = {
  kind: CapabilityKind;
  name: string;
  target: DeployTarget;
  succeeded: boolean;
  sourceMissing?: boolean;
};

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

function applyInstructions(
  fx: DeployFsExec,
  sel: ResolvedSelection,
  outcomes: TargetOutcome[],
): KindResult {
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
      for (const target of sel.targets) {
        outcomes.push({
          kind: "instruction",
          name: item.name,
          target,
          succeeded: false,
          sourceMissing: true,
        });
      }
      continue;
    }
    bodies.push(body);
    resolvedNames.push(item.name);
  }
  const compiled = transformInstructions(bodies);
  // The whole-file write is the unit of success — only mark the names applied
  // once every selected target's file landed. A write fault (EACCES/EROFS) is
  // captured as a per-kind failure, never an untyped defect escaping to a 500.
  let landed = false;
  if (sel.targets.includes("claude")) {
    try {
      const claudeMd = deployedInstructionPath(fx.targets, "claude");
      backupIfExists(claudeMd);
      writeFileAt(claudeMd, compiled);
      landed = true;
      for (const name of resolvedNames)
        outcomes.push({ kind: "instruction", name, target: "claude", succeeded: true });
    } catch (err) {
      for (const name of resolvedNames) res.failed.push({ name, error: String(err) });
      for (const name of resolvedNames)
        outcomes.push({ kind: "instruction", name, target: "claude", succeeded: false });
    }
  }
  if (sel.targets.includes("codex")) {
    try {
      const agentsMd = deployedInstructionPath(fx.targets, "codex");
      backupIfExists(agentsMd);
      writeFileAt(agentsMd, compiled);
      landed = true;
      for (const name of resolvedNames)
        outcomes.push({ kind: "instruction", name, target: "codex", succeeded: true });
    } catch (err) {
      for (const name of resolvedNames) res.failed.push({ name, error: String(err) });
      for (const name of resolvedNames)
        outcomes.push({ kind: "instruction", name, target: "codex", succeeded: false });
    }
  }
  if (landed) res.applied.push(...resolvedNames);
  return res;
}

function applySkills(
  fx: DeployFsExec,
  sel: ResolvedSelection,
  snippets: Map<string, string>,
  outcomes: TargetOutcome[],
): KindResult {
  const res = emptyKind("skill");
  for (const item of sel.skills) {
    const srcDir = skillSourceDir(fx.targets.mirrorRoot(item.sourceId), item.name);
    if (!srcDir) {
      res.failed.push({ name: item.name, error: "source not found in mirror" });
      for (const target of sel.targets)
        outcomes.push({
          kind: "skill",
          name: item.name,
          target,
          succeeded: false,
          sourceMissing: true,
        });
      continue;
    }
    let out: ReturnType<typeof transformSkill>;
    try {
      const files = readSkillSource(srcDir);
      out = transformSkill(
        { name: item.name, files, disableModelInvocation: skillDisablesModelInvocation(srcDir) },
        snippets,
      );
    } catch (err) {
      res.failed.push({ name: item.name, error: String(err) });
      for (const target of sel.targets)
        outcomes.push({ kind: "skill", name: item.name, target, succeeded: false });
      continue;
    }
    let landed = false;
    for (const target of sel.targets) {
      try {
        const skillsDir = deployedSkillDir(fx.targets, item.name, target);
        const allFiles =
          out.sidecar && target === "codex" ? [...out.files, out.sidecar] : out.files;
        writeSkillFolder(skillsDir, allFiles);
        landed = true;
        outcomes.push({ kind: "skill", name: item.name, target, succeeded: true });
      } catch (err) {
        res.failed.push({ name: item.name, error: String(err) });
        outcomes.push({ kind: "skill", name: item.name, target, succeeded: false });
      }
    }
    if (landed) res.applied.push(item.name);
  }
  return res;
}

function applyAgents(
  fx: DeployFsExec,
  sel: ResolvedSelection,
  snippets: Map<string, string>,
  outcomes: TargetOutcome[],
): KindResult {
  const res = emptyKind("agent");
  for (const item of sel.agents) {
    const srcDir = agentSourceDir(fx.targets.mirrorRoot(item.sourceId), item.name);
    if (!srcDir) {
      res.failed.push({ name: item.name, error: "source not found in mirror" });
      for (const target of sel.targets)
        outcomes.push({
          kind: "agent",
          name: item.name,
          target,
          succeeded: false,
          sourceMissing: true,
        });
      continue;
    }
    let out: ReturnType<typeof transformAgent>;
    try {
      const content = readFileSync(join(srcDir, "AGENT.md"), "utf8");
      out = transformAgent({ name: item.name, raw: content }, snippets);
    } catch (err) {
      res.failed.push({ name: item.name, error: String(err) });
      for (const target of sel.targets)
        outcomes.push({ kind: "agent", name: item.name, target, succeeded: false });
      continue;
    }
    let landed = false;
    if (sel.targets.includes("claude")) {
      try {
        writeFileAt(deployedAgentPath(fx.targets, item.name, "claude"), out.claudeMd);
        landed = true;
        outcomes.push({ kind: "agent", name: item.name, target: "claude", succeeded: true });
      } catch (err) {
        res.failed.push({ name: item.name, error: String(err) });
        outcomes.push({ kind: "agent", name: item.name, target: "claude", succeeded: false });
      }
    }
    if (sel.targets.includes("codex")) {
      try {
        writeFileAt(deployedAgentPath(fx.targets, item.name, "codex"), out.codexToml);
        landed = true;
        outcomes.push({ kind: "agent", name: item.name, target: "codex", succeeded: true });
      } catch (err) {
        res.failed.push({ name: item.name, error: String(err) });
        outcomes.push({ kind: "agent", name: item.name, target: "codex", succeeded: false });
      }
    }
    if (landed) res.applied.push(item.name);
  }
  return res;
}

function applyPlugins(
  fx: DeployFsExec,
  sel: ResolvedSelection,
  outcomes: TargetOutcome[],
): KindResult {
  const res = emptyKind("plugin");
  // Claude-only.
  if (!sel.targets.includes("claude")) return res;
  for (const item of sel.plugins) {
    const name = item.name;
    const meta = pluginMeta(fx.targets.mirrorRoot(item.sourceId), name);
    if (!meta) {
      res.failed.push({ name, error: "plugin source not found in mirror" });
      outcomes.push({
        kind: "plugin",
        name,
        target: "claude",
        succeeded: false,
        sourceMissing: true,
      });
      continue;
    }
    if (skipPlugin()) {
      log().warn(
        { module: "kit/deploy", plugin: name },
        "plugin install skipped (AGENT_KIT_SKIP_PLUGIN_INSTALL)",
      );
      res.applied.push(name);
      outcomes.push({ kind: "plugin", name, target: "claude", succeeded: true });
      continue;
    }
    if (!meta.source || !meta.market) {
      res.failed.push({ name, error: "missing marketplace_source/marketplace_name" });
      outcomes.push({ kind: "plugin", name, target: "claude", succeeded: false });
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
        outcomes.push({ kind: "plugin", name, target: "claude", succeeded: false });
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
        outcomes.push({ kind: "plugin", name, target: "claude", succeeded: false });
        continue;
      }
      res.applied.push(name);
      outcomes.push({ kind: "plugin", name, target: "claude", succeeded: true });
    } catch (err) {
      // The not_redirected guard is a blast-radius safety stop — it must abort
      // the deploy, not downgrade to a per-plugin failure.
      if (err instanceof DeployError && err.reason === "not_redirected") throw err;
      res.failed.push({ name, error: String(err) });
      outcomes.push({ kind: "plugin", name, target: "claude", succeeded: false });
    }
  }
  return res;
}

function applyBundles(
  fx: DeployFsExec,
  sel: ResolvedSelection,
  outcomes: TargetOutcome[],
): { result: KindResult; pins: Record<string, string | null> } {
  const res = emptyKind("bundle");
  const pins: Record<string, string | null> = {};
  for (const item of sel.bundles) {
    const name = item.name;
    const meta = bundleMeta(fx.targets.mirrorRoot(item.sourceId), name);
    if (!meta) {
      res.failed.push({ name, error: "bundle source not found in mirror" });
      for (const target of sel.targets)
        outcomes.push({ kind: "bundle", name, target, succeeded: false, sourceMissing: true });
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
      for (const target of sel.targets)
        outcomes.push({ kind: "bundle", name, target, succeeded: true });
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
          if (r.status !== 0) {
            allOk = false;
            outcomes.push({ kind: "bundle", name, target, succeeded: false });
          } else outcomes.push({ kind: "bundle", name, target, succeeded: true });
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
          if (r.status !== 0) {
            allOk = false;
            outcomes.push({ kind: "bundle", name, target, succeeded: false });
          } else outcomes.push({ kind: "bundle", name, target, succeeded: true });
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
      for (const target of sel.targets)
        outcomes.push({ kind: "bundle", name, target, succeeded: false });
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
): {
  pruned: { kind: CapabilityKind; name: string }[];
  removed: { kind: "skill" | "agent"; name: string; target: DeployTarget }[];
  failed: { kind: "skill" | "agent"; name: string; target: DeployTarget }[];
} {
  const pruned: { kind: CapabilityKind; name: string }[] = [];
  const removed: { kind: "skill" | "agent"; name: string; target: DeployTarget }[] = [];
  const failed: { kind: "skill" | "agent"; name: string; target: DeployTarget }[] = [];
  for (const name of pruneSkills) {
    let complete = true;
    for (const target of targets) {
      try {
        removeDir(deployedSkillDir(fx.targets, name, target));
        removed.push({ kind: "skill", name, target });
      } catch {
        complete = false;
        failed.push({ kind: "skill", name, target });
      }
    }
    if (complete) pruned.push({ kind: "skill", name });
  }
  for (const name of pruneAgents) {
    let complete = true;
    if (targets.includes("claude")) {
      try {
        removeFile(deployedAgentPath(fx.targets, name, "claude"));
        removed.push({ kind: "agent", name, target: "claude" });
      } catch {
        complete = false;
        failed.push({ kind: "agent", name, target: "claude" });
      }
    }
    if (targets.includes("codex")) {
      try {
        removeFile(deployedAgentPath(fx.targets, name, "codex"));
        removed.push({ kind: "agent", name, target: "codex" });
      } catch {
        complete = false;
        failed.push({ kind: "agent", name, target: "codex" });
      }
    }
    if (complete) pruned.push({ kind: "agent", name });
  }
  return { pruned, removed, failed };
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
  // Per-kind names the ACTIVE catalog currently provides (#47 data-loss guard).
  // reconcilePrune unlinks an owned-but-deselected name ONLY if it is in this set;
  // an owned name absent from it is an ORPHAN (its Source isn't active) and is KEPT
  // — never auto-deleted. Built at the deploy seam from the same active catalog.
  activeCatalogNames: { skills: readonly string[]; agents: readonly string[] };
  // Task 4 supplies the durable operation id. Keep the direct engine seam usable
  // while orchestration is still synchronous.
  operationId?: string;
};

export function runDeploy(
  fx: DeployFsExec,
  input: DeployInput,
): Effect.Effect<DeployResult, DeployError> {
  return Effect.gen(function* () {
    const sel = input.selection;
    const operationId = input.operationId ?? crypto.randomUUID();

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
    const targetOutcomes: TargetOutcome[] = [];

    // Ordered best-effort: instructions, skills, agents, plugins, bundles.
    perKind.push(applyInstructions(fx, sel, targetOutcomes));
    perKind.push(applySkills(fx, sel, snippets, targetOutcomes));
    perKind.push(applyAgents(fx, sel, snippets, targetOutcomes));

    let pluginResult: KindResult;
    let bundlePins: Record<string, string | null> = {};
    let bundleResult: KindResult;
    try {
      pluginResult = applyPlugins(fx, sel, targetOutcomes);
    } catch (err) {
      // A not_redirected guard throw aborts the deploy (it's a real safety stop).
      if (err instanceof DeployError && err.reason === "not_redirected") {
        return yield* Effect.fail(err);
      }
      pluginResult = { kind: "plugin", applied: [], failed: [{ name: "*", error: String(err) }] };
    }
    perKind.push(pluginResult);

    try {
      const b = applyBundles(fx, sel, targetOutcomes);
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
    // request start AND are now deselected AND still in the active catalog — never a
    // concurrently-CLI-added name, never an owned-but-absent orphan (#47).
    const orphan = reconcilePrune(
      fx.targets,
      sel.skills.map((i) => i.name),
      sel.agents.map((i) => i.name),
      priorOwned,
      {
        skills: new Set(input.activeCatalogNames.skills),
        agents: new Set(input.activeCatalogNames.agents),
      },
    );
    const pruneOutcome = pruneOrphans(fx, orphan.skills, orphan.agents, sel.targets);

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
      pruneOutcome.pruned.filter((entry) => entry.kind === "skill").map((entry) => entry.name),
      pruneOutcome.pruned.filter((entry) => entry.kind === "agent").map((entry) => entry.name),
    );

    // Deployment State is Hive-private authority for factual outcomes. It is
    // committed only after the filesystem apply/removal and the interoperable
    // Ledger merge above have succeeded. The Ledger bytes remain untouched.
    yield* Effect.try({
      try: () => {
        const state = openDeploymentStateStore(fx.targets.deploymentStatePath(), {
          legacyFingerprintPath: fx.targets.fingerprintPath(),
        });
        const sourceByKind = new Map<CapabilityKind, Map<string, string>>([
          ["instruction", new Map(sel.instructions.map((item) => [item.name, item.sourceId]))],
          ["skill", new Map(sel.skills.map((item) => [item.name, item.sourceId]))],
          ["agent", new Map(sel.agents.map((item) => [item.name, item.sourceId]))],
          ["plugin", new Map(sel.plugins.map((item) => [item.name, item.sourceId]))],
          ["bundle", new Map(sel.bundles.map((item) => [item.name, item.sourceId]))],
        ]);
        const renderedHash = (
          kind: CapabilityKind,
          name: string,
          target: DeployTarget,
        ): string | null => {
          if (kind === "skill") return hashDeployedSkill(fx.targets, name, target);
          if (kind === "agent") return hashDeployedAgent(fx.targets, name, target);
          if (kind === "instruction") return hashDeployedInstruction(fx.targets, target);
          const sourceId = sourceByKind.get(kind)?.get(name);
          return sourceId ? mirrorContentSha(fx.targets.mirrorRoot(sourceId), kind, name) : null;
        };
        for (const outcome of targetOutcomes) {
          const sourceId = sourceByKind.get(outcome.kind)?.get(outcome.name);
          if (!sourceId) continue;
          if (!outcome.succeeded) {
            state.recordFailure(
              { kind: outcome.kind, name: outcome.name },
              outcome.target,
              {
                action: state.read({ kind: outcome.kind, name: outcome.name }, outcome.target)
                  ?.applied
                  ? "update"
                  : "add",
                code: outcome.sourceMissing ? "source_missing" : "io",
                detail: outcome.sourceMissing
                  ? "source unavailable in mirror"
                  : "deploy action failed",
              },
              operationId,
            );
            continue;
          }
          const contentSha = mirrorContentSha(
            fx.targets.mirrorRoot(sourceId),
            outcome.kind,
            outcome.name,
          );
          const hash = renderedHash(outcome.kind, outcome.name, outcome.target);
          if (!contentSha || !hash) {
            state.recordFailure(
              { kind: outcome.kind, name: outcome.name },
              outcome.target,
              {
                action: state.read({ kind: outcome.kind, name: outcome.name }, outcome.target)
                  ?.applied
                  ? "update"
                  : "add",
                code: "io",
                detail: "rendered deployment fingerprint unavailable",
              },
              operationId,
            );
            continue;
          }
          state.recordSuccess(
            { kind: outcome.kind, name: outcome.name },
            outcome.target,
            { sourceId, contentSha, renderedHash: hash, appliedAt: Date.now() },
            operationId,
          );
        }
        for (const removed of pruneOutcome.removed) {
          state.recordRemoval(
            { kind: removed.kind, name: removed.name },
            removed.target,
            operationId,
          );
        }
        for (const failedRemoval of pruneOutcome.failed) {
          state.recordFailure(
            { kind: failedRemoval.kind, name: failedRemoval.name },
            failedRemoval.target,
            {
              action: "remove",
              code: "io",
              detail: "deployment removal failed",
            },
            operationId,
          );
        }
      },
      catch: (err) =>
        new DeployError({ reason: "io", message: `deployment state write failed: ${String(err)}` }),
    });

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
          pruneOutcome.pruned.filter((entry) => entry.kind === "skill").map((entry) => entry.name),
          pruneOutcome.pruned.filter((entry) => entry.kind === "agent").map((entry) => entry.name),
          Date.now(),
        );
      } catch (err) {
        log().warn({ module: "kit/deploy", err: String(err) }, "fingerprint recording failed");
      }
    });

    return {
      kitSha: input.kitSha,
      perKind,
      pruned: pruneOutcome.pruned,
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
