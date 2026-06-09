import { describe, expect, test } from "bun:test";
import { deriveThreadStatus, type ThreadStatus } from "../status.ts";

describe("deriveThreadStatus (AC #7 — pure derivation)", () => {
  const cases: Array<{
    name: string;
    input: { isBusy: boolean; newestCompletedEndedAt: number | null; lastReadAt: number | null };
    expected: ThreadStatus;
  }> = [
    {
      name: "in-flight Run wins → running (even with unread completed work)",
      input: { isBusy: true, newestCompletedEndedAt: 100, lastReadAt: null },
      expected: "running",
    },
    {
      name: "never read + at least one completed Run → unread",
      input: { isBusy: false, newestCompletedEndedAt: 100, lastReadAt: null },
      expected: "unread",
    },
    {
      name: "completed after last read → unread",
      input: { isBusy: false, newestCompletedEndedAt: 200, lastReadAt: 150 },
      expected: "unread",
    },
    {
      name: "completed at/before last read → idle",
      input: { isBusy: false, newestCompletedEndedAt: 150, lastReadAt: 150 },
      expected: "idle",
    },
    {
      name: "read after the newest completion → idle",
      input: { isBusy: false, newestCompletedEndedAt: 100, lastReadAt: 150 },
      expected: "idle",
    },
    {
      name: "no completed Run, never read → idle",
      input: { isBusy: false, newestCompletedEndedAt: null, lastReadAt: null },
      expected: "idle",
    },
    {
      name: "no completed Run but read → idle",
      input: { isBusy: false, newestCompletedEndedAt: null, lastReadAt: 999 },
      expected: "idle",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(deriveThreadStatus(c.input)).toBe(c.expected);
    });
  }
});
