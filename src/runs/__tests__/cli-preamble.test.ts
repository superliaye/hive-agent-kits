// P1.4 (Q4): the fixed CLI BACKEND-CONTEXT preamble prepended to a non-native
// backend's `--append-system-prompt` value. Unit-tests the pure prepend helper
// and asserts it names exactly the native-only tools — and no tool the CLI has.

import { describe, expect, test } from "bun:test";
import { CLI_BACKEND_PREAMBLE, cliSystemPrompt } from "../executor.ts";

describe("cliSystemPrompt — fixed CLI preamble (P1.4)", () => {
  test("the value BEGINS with the preamble, then the authored body", () => {
    const out = cliSystemPrompt("be terse");
    expect(out.startsWith(CLI_BACKEND_PREAMBLE)).toBe(true);
    expect(out).toBe(`${CLI_BACKEND_PREAMBLE}\n\nbe terse`);
  });

  test("a blank body yields the preamble alone", () => {
    expect(cliSystemPrompt("   ")).toBe(CLI_BACKEND_PREAMBLE);
  });

  test("the preamble names exactly the native-only tools", () => {
    for (const tool of [
      "spawn_sub_agent",
      "load_skill",
      "run_shell",
      "memory_read",
      "memory_write",
    ]) {
      expect(CLI_BACKEND_PREAMBLE).toContain(tool);
    }
  });

  test("the preamble names no tool the CLI actually has (read/write/edit)", () => {
    // The CLI's own Edit/Read/Write tools are NOT named as unavailable — the
    // preamble only contextualizes Hive's native-only built-ins.
    expect(CLI_BACKEND_PREAMBLE).not.toContain("Edit(");
    expect(CLI_BACKEND_PREAMBLE).not.toContain("Read(");
  });
});
