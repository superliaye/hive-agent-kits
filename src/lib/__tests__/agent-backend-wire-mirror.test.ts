import { describe, expect, test } from "bun:test";
import { AgentBackend } from "../capability-types.ts";

// Wire-enum drift guard (r1-architecture-2 / OQ-4).
//
// The daemon owns the authoritative `AgentBackend` value set
// (`src/lib/capability-types.ts`). The UI is a separate Vite bundle, so it
// hand-mirrors that value set as a literal (`ui/src/api.ts` `AGENT_BACKENDS`):
//
//   const AGENT_BACKENDS = ["claude-code", "codex"] as const;
//
// Nothing in the build couples the two, so they can silently drift if a backend
// is added or removed on one side only. This test pins the daemon's
// authoritative set against the literal the wire/UI mirror is expected to carry.
// When the daemon enum changes, this test fails loudly — the fix is to update
// BOTH this expectation and the UI hand-mirror together.
describe("AgentBackend wire mirror (drift guard, r1-architecture-2)", () => {
  // The value set the UI's `AGENT_BACKENDS` hand-mirror is expected to equal.
  // Order-independent equality (a Set): the mirror is a value set, not a list.
  const EXPECTED_WIRE_MIRROR = ["claude-code", "codex"] as const;

  test("daemon AgentBackend value set equals the UI hand-mirror's expected set", () => {
    expect(new Set(AgentBackend.options)).toEqual(new Set(EXPECTED_WIRE_MIRROR));
  });
});
