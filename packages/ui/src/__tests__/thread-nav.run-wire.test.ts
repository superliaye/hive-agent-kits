// Regression guard for the live status-dot SSE wire names. ChatPage subscribes
// to RUN_WIRE_EVENTS on /api/events; the daemon emits double-prefixed frame
// names (`${source}.${type}` => `run.run.<verb>`). That double-prefix is a
// non-obvious footgun that has regressed before (finding F1). This pins the UI
// side of the contract; the daemon side is pinned in
// src/server/__tests__/routes-threads-runs.test.ts, which asserts frames named
// "run.run.started" and "run.run.completed" flow on the events stream.
//
// Pure (no DOM): the names are hoisted out of ChatPage's effect into the
// thread-nav core precisely so the contract is testable without mounting React.

import { describe, expect, test } from "bun:test";
import { RUN_WIRE_EVENTS } from "../thread-nav.ts";

describe("run SSE wire names", () => {
  // Mirrors the literals asserted on the daemon side
  // (routes-threads-runs.test.ts). Keep these two in lockstep: a daemon rename
  // must change both, and this test fails if the UI list drifts.
  const EXPECTED = [
    "run.run.started",
    "run.run.completed",
    "run.run.failed",
    "run.run.cancelled",
  ] as const;

  test("ChatPage subscribes to exactly the daemon's double-prefixed run frames", () => {
    expect([...RUN_WIRE_EVENTS]).toEqual([...EXPECTED]);
  });

  test("every wire name is double-prefixed run.run.<verb> (the F1 footgun)", () => {
    for (const name of RUN_WIRE_EVENTS) {
      expect(name).toMatch(/^run\.run\.[a-z]+$/);
    }
  });
});
