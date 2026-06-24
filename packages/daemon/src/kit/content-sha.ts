// ContentSha producer — the content identity of a Capability, hashed from its
// SOURCE Mirror bytes (ADR-0023 / grill Q2). This is the merge-equality signal:
// two Mirrors that ship byte-identical content for a CapabilityKey produce the
// SAME ContentSha and Merge into one catalog entry; a byte difference (Q3 —
// byte-identical, no normalization) yields different ContentShas → separate
// Variants (a Collision: precedence winner + Shadowed losers).
//
// NOT the deployed/post-render hashers in deploy/artifact-hash.ts (those hash the
// rendered target bytes, cover only 3 kinds, and the instruction one is
// target-scoped over the concatenation). The merge identity is a property of the
// source Capability, not a per-target rendered artifact. The hash PRIMITIVE
// (`hashSkillFiles`: sorted rel-path + NUL + sha256 → 64-hex) is reused so the
// hash stays one algorithm across all 5 kinds.
//
// Boundary note (grill Q1): this producer stays in `kit/` this slice (alongside
// the catalog orchestration); only the PURE merge/precedence algorithm lives in
// the Sources context (sources/aggregation.ts). A full relocation rides with the
// deferred KitSvc catalog()/sync() split.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { CapabilityKind } from "@hive/contract";
import { hashSkillFiles } from "./deploy/artifact-hash.ts";
import { agentSourceDir, capabilityFilePath, skillSourceDir } from "./deploy/sources.ts";

// Collect every file under a folder, rel paths RELATIVE TO that folder (so an
// @group/ placement of an identical skill hashes equal to a flat one). Returns
// null when the folder is absent.
function folderFileSet(dir: string): { rel: string; content: string }[] | null {
  if (!existsSync(dir)) return null;
  const files: { rel: string; content: string }[] = [];
  const walk = (d: string, base: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      try {
        if (ent.isDirectory()) walk(full, rel);
        else if (ent.isFile()) files.push({ rel, content: readFileSync(full, "utf8") });
      } catch {
        // unreadable child — skip; a vanished file mid-walk must not throw here.
      }
    }
  };
  walk(dir, "");
  return files;
}

// The ContentSha of a Capability from its source Mirror bytes, or null when the
// Capability's bytes are missing/unreadable (a null ContentSha is excluded from
// winning in the aggregation — it can't be deployed with no readable bytes).
//
//   skill / agent — folder-marker kinds: hash the WHOLE leaf-folder file-set with
//                   paths relative to the leaf dir.
//   instruction / plugin / bundle — single file: hash as one entry whose `rel` is
//                   the BARE filename (never the mirror-rooted path), so two
//                   Mirrors of identical content hash equal.
export function mirrorContentSha(
  mirrorRoot: string,
  kind: CapabilityKind,
  name: string,
): string | null {
  if (kind === "skill" || kind === "agent") {
    const leafDir =
      kind === "skill" ? skillSourceDir(mirrorRoot, name) : agentSourceDir(mirrorRoot, name);
    if (!leafDir) return null;
    const files = folderFileSet(leafDir);
    if (!files || files.length === 0) return null;
    return hashSkillFiles(files);
  }
  const path = capabilityFilePath(mirrorRoot, kind, name);
  if (!existsSync(path)) return null;
  let content: string;
  try {
    if (!statSync(path).isFile()) return null;
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // `rel` is the bare filename, never the mirror-rooted path — the merge-equality
  // invariant (two Mirrors of identical content hash equal).
  return hashSkillFiles([{ rel: basename(path), content }]);
}
