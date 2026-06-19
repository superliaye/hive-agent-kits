// Self-check / verify pass (Feature 1 + drift from Feature 2).
//
// The ledger records INTENT/ownership; it does not observe disk. This pass stats
// each ledger entry's expected on-disk target path(s) — resolved via DeployTargets
// and gated by the ledger's `agents` (the target CLIs) — and reports a per-target
// status. With a recorded integrity fingerprint, a present skill/agent/instruction
// is further checked for drift (edited since deploy).
//
// Read-only: emits NO audit row; diagnostics go to the trace logger only.

import { existsSync } from "node:fs";
import { log } from "../lib/log.ts";
import {
  deployedAgentPath,
  deployedInstructionPath,
  deployedSkillDir,
  hashDeployedAgent,
  hashDeployedInstruction,
  hashDeployedSkill,
} from "./deploy/artifact-hash.ts";
import { type FingerprintFile, fingerprintFor, readFingerprints } from "./fingerprint.ts";
import { type Ledger, readLedger } from "./ledger.ts";
import type { DeployTarget, DeployTargets } from "./targets.ts";
import type { VerifyEntry, VerifyReport, VerifyStatus, VerifyTargetStatus } from "./types.ts";

// The CLI targets a ledger records (its top-level `agents` host list). Narrow to
// the two known deploy targets; an unknown string is ignored rather than trusted.
function ledgerTargets(ledger: Ledger): DeployTarget[] {
  return ledger.agents.filter((a): a is DeployTarget => a === "claude" || a === "codex");
}

// Stat + drift one stat-verifiable artifact (skill/agent/instruction) under one
// target. existence = present|missing; with a fingerprint, present→drifted on a
// disk-hash mismatch. NO fingerprint ⇒ stay present (never false-alarm).
function statArtifact(
  targets: DeployTargets,
  fingerprints: FingerprintFile,
  kind: "skill" | "agent" | "instruction",
  name: string,
  target: DeployTarget,
): VerifyStatus {
  const path =
    kind === "skill"
      ? deployedSkillDir(targets, name, target)
      : kind === "agent"
        ? deployedAgentPath(targets, name, target)
        : deployedInstructionPath(targets, target);
  if (!existsSync(path)) return "missing";

  const recorded = fingerprintFor(fingerprints, kind, name, target);
  if (!recorded) return "present";

  // Recompute the disk hash for drift. A read fault (EACCES, or a concurrent
  // deletion between existsSync and the hash walk) must NOT 500 the read-only
  // verify route — treat it as missing and trace, matching the tolerant-read
  // posture of readLedger/readFingerprints.
  let diskHash: string | null;
  try {
    diskHash =
      kind === "skill"
        ? hashDeployedSkill(targets, name, target)
        : kind === "agent"
          ? hashDeployedAgent(targets, name, target)
          : hashDeployedInstruction(targets, target);
  } catch (err) {
    log().warn(
      { module: "kit/verify", kind, name, target, err: String(err) },
      "verify: artifact became unreadable during hash; reporting missing",
    );
    return "missing";
  }
  if (!diskHash) return "missing";
  return diskHash === recorded ? "present" : "drifted";
}

function statAcrossTargets(
  targets: DeployTargets,
  fingerprints: FingerprintFile,
  kind: "skill" | "agent" | "instruction",
  name: string,
  clis: DeployTarget[],
): VerifyTargetStatus[] {
  return clis.map((target) => ({
    target,
    status: statArtifact(targets, fingerprints, kind, name, target),
  }));
}

// Run the verify pass over the current ledger. Returns a per-capability,
// per-target on-disk status report. Pure read — no audit, no mutation.
export function runVerify(targets: DeployTargets): VerifyReport {
  const ledger = readLedger(targets);
  if (!ledger) return { entries: [] };
  const clis = ledgerTargets(ledger);
  const fingerprints = readFingerprints(targets);
  const entries: VerifyEntry[] = [];

  for (const s of ledger.skills) {
    entries.push({
      kind: "skill",
      name: s.name,
      targets: statAcrossTargets(targets, fingerprints, "skill", s.name, clis),
    });
  }
  for (const a of ledger.agentDefs) {
    entries.push({
      kind: "agent",
      name: a.name,
      targets: statAcrossTargets(targets, fingerprints, "agent", a.name, clis),
    });
  }
  for (const i of ledger.instructions) {
    entries.push({
      kind: "instruction",
      name: i.name,
      targets: statAcrossTargets(targets, fingerprints, "instruction", i.name, clis),
    });
  }
  // plugin / bundle: external-installer owned, not stat-verifiable. Mark every
  // targeted CLI `recorded` — never claim present/missing for these. (When the
  // ledger records no CLI yet, fall back to a single `recorded` row so the
  // capability still surfaces.)
  const recordedTargets = recordedOnly(clis);
  for (const p of ledger.plugins) {
    entries.push({ kind: "plugin", name: p.name, targets: recordedTargets });
  }
  for (const b of ledger.bundles) {
    entries.push({ kind: "bundle", name: b.name, targets: recordedTargets });
  }

  log().debug(
    { module: "kit/verify", capabilities: entries.length, targets: clis },
    "kit verify pass complete",
  );
  return { entries };
}

// plugin/bundle carry a `recorded` status on each targeted CLI (or a lone claude
// row when the ledger records no CLI yet).
function recordedOnly(clis: DeployTarget[]): VerifyTargetStatus[] {
  const targets = clis.length > 0 ? clis : (["claude"] as DeployTarget[]);
  return targets.map((target) => ({ target, status: "recorded" as VerifyStatus }));
}
