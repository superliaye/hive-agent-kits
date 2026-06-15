/**
 * Unit tests for the no-floating-promises gate's pure pieces.
 *
 * Real failure modes:
 *   - isThenable must distinguish a Promise-typed expr from a primitive one
 *     (the false-positive that would flag `void sources.gateway`)
 *   - findRuleSuppressions must match ONLY the noFloatingPromises rule path,
 *     not the two pre-existing suppressions
 *   - the deliberate-failure smoke test proves the detector fails when it
 *     should: a fixture with one `void Promise.resolve()` + one rule-suppression
 *     comment must report exactly 2 violations.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import {
  buildProgram,
  findRuleSuppressions,
  isThenable,
  scanProgram,
  scanSrc,
} from "../check-no-floating-suppressions.ts";

// Tests that build a real TS Program parse the default lib — CPU-bound work that,
// under a loaded machine (a live dev stack saturating the cores), gets starved well
// past bun's 5s default and times out (~1-in-4 with the stack up). The work is
// legitimately slow, not hung; size the timeout to it so the suite is deterministic
// under load. Pure-string tests below keep the tight 5s default as a hang detector.
const TS_TIMEOUT = 30_000;

/** Compile a one-file program from source text and return its checker + file. */
function compile(src: string): { checker: ts.TypeChecker; file: ts.SourceFile } {
  const dir = join(
    tmpdir(),
    `hive-float-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "frag.ts");
  writeFileSync(path, src);
  const program = buildProgram([path]);
  const file = program.getSourceFile(path);
  if (!file) throw new Error("source file not in program");
  return { checker: program.getTypeChecker(), file };
}

/** First initializer type of a `const x = …;` declaration. */
function initType(checker: ts.TypeChecker, file: ts.SourceFile): ts.Type {
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      found = checker.getTypeAtLocation(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error("no const initializer found");
  return found;
}

describe("isThenable", () => {
  test(
    "true for a Promise<void>-typed expression",
    () => {
      const { checker, file } = compile("const x = Promise.resolve();");
      expect(isThenable(checker, initType(checker, file))).toBe(true);
    },
    TS_TIMEOUT,
  );

  test(
    "false for a number expression",
    () => {
      const { checker, file } = compile("const x = 1;");
      expect(isThenable(checker, initType(checker, file))).toBe(false);
    },
    TS_TIMEOUT,
  );

  test(
    "false for a string expression",
    () => {
      const { checker, file } = compile('const x = "hi";');
      expect(isThenable(checker, initType(checker, file))).toBe(false);
    },
    TS_TIMEOUT,
  );
});

describe("findRuleSuppressions", () => {
  test("matches a noFloatingPromises suppression", () => {
    const text = "// biome-ignore lint/nursery/noFloatingPromises: reason\nvoid p();";
    expect(findRuleSuppressions(text)).toEqual([1]);
  });

  test("does NOT match noExplicitAny / noAssignInExpressions (the pre-existing ones)", () => {
    const text = [
      "// biome-ignore lint/suspicious/noExplicitAny: stub emitter",
      "// biome-ignore lint/suspicious/noAssignInExpressions: ndjson parse",
    ].join("\n");
    expect(findRuleSuppressions(text)).toEqual([]);
  });

  test("does NOT match the rule path embedded in prose or a string literal", () => {
    const text = [
      " *   - `biome-ignore lint/nursery/noFloatingPromises` suppressions.",
      '    const text = "// biome-ignore lint/nursery/noFloatingPromises: x";',
    ].join("\n");
    expect(findRuleSuppressions(text)).toEqual([]);
  });
});

describe("scanProgram", () => {
  test(
    "flags `void <promise>` but not `void <non-promise>`",
    () => {
      const dir = join(tmpdir(), `hive-float-vp-${Date.now()}`, "src");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "frag.ts");
      writeFileSync(
        path,
        ["async function p() {}", "const n = 1;", "void p();", "void n;"].join("\n"),
      );
      const program = buildProgram([path]);
      const hits = scanProgram(program);
      expect(hits.length).toBe(1);
      expect(hits[0]?.line).toBe(3);
      rmSync(join(tmpdir(), `hive-float-vp-${Date.now()}`), { recursive: true, force: true });
    },
    TS_TIMEOUT,
  );
});

describe("deliberate-failure smoke", () => {
  test(
    "a fixture with one void-promise and one rule-suppression reports exactly 2 violations",
    () => {
      const root = join(tmpdir(), `hive-float-smoke-${Date.now()}`);
      const src = join(root, "src");
      mkdirSync(src, { recursive: true });
      writeFileSync(
        join(src, "bad.ts"),
        [
          "// biome-ignore lint/nursery/noFloatingPromises: deliberately wrong",
          "export function bad(): void {",
          "  void Promise.resolve();",
          "}",
        ].join("\n"),
      );
      const violations = scanSrc(src);
      expect(violations.length).toBe(2);
      expect(violations.some((v) => v.kind === "void-promise")).toBe(true);
      expect(violations.some((v) => v.kind === "rule-suppression")).toBe(true);
      rmSync(root, { recursive: true, force: true });
    },
    TS_TIMEOUT,
  );
});
