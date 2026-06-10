import { describe, expect, test } from "bun:test";
import { type DeriveThreadStatusInput, deriveThreadStatus, type ThreadStatus } from "../status.ts";

describe("deriveThreadStatus (AC #7 — pure derivation)", () => {
  const cases: Array<{
    name: string;
    input: DeriveThreadStatusInput;
    expected: ThreadStatus;
  }> = [
    {
      name: "in-flight Run wins → running (even with unread completed work)",
      input: {
        isBusy: true,
        newestTerminal: { status: "completed", endedAt: 100 },
        lastReadAt: null,
      },
      expected: "running",
    },
    {
      name: "in-flight Run wins over a failed terminal → running",
      input: {
        isBusy: true,
        newestTerminal: { status: "failed", endedAt: 100 },
        lastReadAt: null,
      },
      expected: "running",
    },
    {
      name: "never read + at least one completed Run → unread",
      input: {
        isBusy: false,
        newestTerminal: { status: "completed", endedAt: 100 },
        lastReadAt: null,
      },
      expected: "unread",
    },
    {
      name: "completed after last read → unread",
      input: {
        isBusy: false,
        newestTerminal: { status: "completed", endedAt: 200 },
        lastReadAt: 150,
      },
      expected: "unread",
    },
    {
      name: "completed at/before last read → idle",
      input: {
        isBusy: false,
        newestTerminal: { status: "completed", endedAt: 150 },
        lastReadAt: 150,
      },
      expected: "idle",
    },
    {
      name: "read after the newest completion → idle",
      input: {
        isBusy: false,
        newestTerminal: { status: "completed", endedAt: 100 },
        lastReadAt: 150,
      },
      expected: "idle",
    },
    {
      name: "no terminal Run, never read → idle",
      input: { isBusy: false, newestTerminal: null, lastReadAt: null },
      expected: "idle",
    },
    {
      name: "no terminal Run but read → idle",
      input: { isBusy: false, newestTerminal: null, lastReadAt: 999 },
      expected: "idle",
    },
    {
      name: "newest terminal failed + unseen → failed",
      input: {
        isBusy: false,
        newestTerminal: { status: "failed", endedAt: 100 },
        lastReadAt: null,
      },
      expected: "failed",
    },
    {
      name: "newest terminal cancelled + unseen → failed",
      input: {
        isBusy: false,
        newestTerminal: { status: "cancelled", endedAt: 100 },
        lastReadAt: null,
      },
      expected: "failed",
    },
    {
      name: "failed then a newer completed Run → unread (newest terminal wins)",
      input: {
        isBusy: false,
        newestTerminal: { status: "completed", endedAt: 200 },
        lastReadAt: null,
      },
      expected: "unread",
    },
    {
      name: "failed but read (endedAt <= lastReadAt) → idle (clears on read)",
      input: {
        isBusy: false,
        newestTerminal: { status: "failed", endedAt: 100 },
        lastReadAt: 100,
      },
      expected: "idle",
    },
    {
      name: "cancelled but read → idle (clears on read)",
      input: {
        isBusy: false,
        newestTerminal: { status: "cancelled", endedAt: 100 },
        lastReadAt: 150,
      },
      expected: "idle",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(deriveThreadStatus(c.input)).toBe(c.expected);
    });
  }
});
