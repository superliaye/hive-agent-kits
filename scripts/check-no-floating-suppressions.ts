#!/usr/bin/env bun
/**
 * Non-suppressible no-floating-promises gate (ADR-0012 closes the "Known gap").
 *
 * Biome's nursery/noFloatingPromises treats `void p` as VALID — the canonical
 * "deliberately ignore this promise" escape hatch. So Biome alone cannot enforce
 * the operator's directive ("forbid `void someAsync()`"). This script is the
 * teeth: it walks src/**\/*.ts off the TS type-checker and fails on either
 *
 *   (a) a noFloatingPromises rule-suppression comment, or
 *   (b) a `void <promise>` expression (operand type is thenable).
 *
 * It uses the raw TS compiler API (typescript is already a dep) so it does not
 * false-positive on `void <non-promise>` (e.g. the intentional `void
 * sources.gateway` discards in audit/subscriptions.ts).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript";

export type Violation = { file: string; line: number; kind: "void-promise" | "rule-suppression" };

const SRC_ROOT = resolve(import.meta.dir, "..", "src");

/** A symbol's type is thenable iff it has a callable `then` member. */
export function isThenable(checker: ts.TypeChecker, type: ts.Type): boolean {
  const then = type.getProperty("then");
  if (!then) return false;
  const decl = then.valueDeclaration ?? then.declarations?.[0];
  if (!decl) return false;
  return checker.getTypeOfSymbolAtLocation(then, decl).getCallSignatures().length > 0;
}

/**
 * Lines carrying a `biome-ignore` comment that suppresses noFloatingPromises.
 * Matches the v2 rule path specifically — other suppressions (noExplicitAny,
 * noAssignInExpressions) must NOT match.
 */
export function findRuleSuppressions(text: string): number[] {
  const re = /biome-ignore\s+lint\/nursery\/noFloatingPromises/;
  const lines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (re.test(line)) lines.push(i + 1);
  });
  return lines;
}

/** Every `void <promise>` expression across the Program's src source files. */
export function findVoidPromises(program: ts.Program): Violation[] {
  const checker = program.getTypeChecker();
  const out: Violation[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.includes("/src/") && !sf.fileName.includes("\\src\\")) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isVoidExpression(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        if (isThenable(checker, type)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          out.push({ file: sf.fileName, line: line + 1, kind: "void-promise" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

export function buildProgram(roots: string[]): ts.Program {
  return ts.createProgram(roots, {
    allowImportingTsExtensions: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
}

export function scanSrc(srcRoot = SRC_ROOT): Violation[] {
  const files = collectTsFiles(srcRoot);
  const program = buildProgram(files);
  const violations = findVoidPromises(program);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const line of findRuleSuppressions(text)) {
      violations.push({ file, line, kind: "rule-suppression" });
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = scanSrc();
  for (const v of violations) {
    const what =
      v.kind === "void-promise"
        ? "void <promise> — await or .catch() it (route to trace, never audit)"
        : "noFloatingPromises suppression is not allowed";
    process.stderr.write(`${v.file}:${v.line}  ${what}\n`);
  }
  if (violations.length > 0) {
    process.stderr.write(`\n${violations.length} floating-promise violation(s).\n`);
  }
  process.exit(violations.length > 0 ? 1 : 0);
}
