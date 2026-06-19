// Regression guard for the production exec wiring (bunExec / bunBinaryProbe).
//
// The acceptance run surfaced a real bug: on Windows the probe resolved a
// `claude.cmd` shim while the bare-`claude` install spawn ENOENT'd and threw an
// UNTYPED Error, escaping the deploy's typed error channel and producing an
// opaque 500. The fix routes both probe and exec through the same shell on
// win32, and bunExec never throws — a spawn failure is a non-zero status. These
// tests pin both properties using a binary that is guaranteed absent.

import { describe, expect, test } from "bun:test";
import { bunBinaryProbe, bunExec, type ExecResult } from "../deploy/adapter.ts";

const MISSING = "hive-definitely-not-a-real-binary-xyz";

describe("production exec wiring", () => {
  test("bunExec NEVER throws on a missing binary — it returns a non-zero status", () => {
    let result: ExecResult | null = null;
    expect(() => {
      result = bunExec({ command: MISSING, args: ["--version"] }, process.env);
    }).not.toThrow();
    expect(result).not.toBeNull();
    // result is assigned inside the closure above; narrow for the status check.
    const status = result === null ? 0 : (result as ExecResult).status;
    expect(status).not.toBe(0);
  });

  test("bunBinaryProbe reports a genuinely-absent binary as false", () => {
    expect(bunBinaryProbe(MISSING, process.env)).toBe(false);
  });

  test("probe and exec agree on a missing binary (no probe-passes-but-exec-ENOENTs asymmetry)", () => {
    const probed = bunBinaryProbe(MISSING, process.env);
    const exec = bunExec({ command: MISSING, args: ["--version"] }, process.env);
    // Both must see the binary as unavailable: probe false AND exec non-zero.
    expect(probed).toBe(false);
    expect(exec.status).not.toBe(0);
  });
});
