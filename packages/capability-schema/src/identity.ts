// Identity value objects for the capability format (ADR-0024). These are the
// cross-source / deploy invariants the anti-corruption schema owns, not a
// downstream caller. Pure: zod only, no hashing (hashing stays in the daemon's
// kit/deploy/artifact-hash.ts, which uses node crypto).

import { z } from "zod";

// The five deployable capability kinds (upstream taxonomy) — the SSOT;
// `@hive/contract` re-exports this. `snippet` is a build-time include, not a
// deploy kind.
export const CapabilityKind = z.enum(["instruction", "skill", "agent", "plugin", "bundle"]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

// Content hash of a Capability — the content identity. A branded 64-hex
// validator only; `.brand()` (no cast) keeps it distinct from a plain string at
// the type level so callers can't pass an arbitrary string where a verified hash
// is required. Lowercase-only by design — the daemon's producer
// (kit/deploy/artifact-hash.ts) uses node crypto `digest("hex")`, which emits
// lowercase.
export const ContentSha = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<"ContentSha">();
export type ContentSha = z.infer<typeof ContentSha>;

// A leaf name is the agent-kit deploy identity: unique per kind inside a CLI
// home (ADR-0023; a Deploy flattens every Capability to its leaf name). Reject
// path separators, a `:` (the CapabilityKey serialization delimiter, and an
// invalid path char on Windows), and a leading dot — a leaf name is never a path
// and never a serialized key fragment.
export const LeafName = z
  .string()
  .min(1)
  .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes(":"), {
    message: "leaf name must not contain a path separator or ':'",
  })
  .refine((s) => !s.startsWith("."), {
    message: "leaf name must not start with a dot",
  });
export type LeafName = z.infer<typeof LeafName>;

// CapabilityKey = (kind, leaf-name): the deploy identity that must be unique per
// kind inside a CLI home.
export const CapabilityKey = z.object({
  kind: CapabilityKind,
  name: LeafName,
});
export type CapabilityKey = z.infer<typeof CapabilityKey>;

// Canonical `${kind}:${name}` string — the single SSOT for the deploy-identity
// string currently re-derived ad hoc in kit/catalog.ts and kit/selection.ts.
export function serializeCapabilityKey(key: CapabilityKey): string {
  return `${key.kind}:${key.name}`;
}

// Parse a `${kind}:${name}` string back into a validated CapabilityKey. Rejects
// a malformed string, a bad kind, or a name carrying a path separator. The name
// may itself contain no colon constraint beyond the leaf-name grammar; only the
// first colon separates kind from name.
export function parseCapabilityKey(serialized: string): CapabilityKey {
  const colon = serialized.indexOf(":");
  if (colon === -1) {
    throw new Error(`invalid CapabilityKey: missing ":" in "${serialized}"`);
  }
  const kind = serialized.slice(0, colon);
  const name = serialized.slice(colon + 1);
  return CapabilityKey.parse({ kind, name });
}
