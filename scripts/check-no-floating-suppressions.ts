#!/usr/bin/env bun
/**
 * Non-suppressible no-floating-promises gate (ADR-0012 closes the "Known gap").
 *
 * Biome's nursery/noFloatingPromises treats `void p` as VALID — the canonical
 * "deliberately ignore this promise" escape hatch. So Biome alone cannot enforce
 * the operator's directive ("forbid `void someAsync()`"). This script is the
 * teeth: it walks the src/ + scripts/ *.ts off the TS type-checker (each file
 * read once, from the loaded SourceFile) and fails on either
 *
 *   (a) a noFloatingPromises rule-suppression comment, or
 *   (b) a `void <promise>` expression (operand type is thenable).
 *
 * It uses the raw TS compiler API (typescript is already a dep) so it does not
 * false-positive on `void <non-promise>` (e.g. the intentional `void
 * sources.gateway` discards in audit/subscriptions.ts).
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript";

export type Violation = { file: string; line: number; kind: "void-promise" | "rule-suppression" };

const SRC_ROOT = resolve(import.meta.dir, "..", "src");
const SCRIPTS_ROOT = resolve(import.meta.dir);
const SCAN_ROOTS = [SRC_ROOT, SCRIPTS_ROOT];

/** True for a non-declaration source file under one of the scan roots. */
function inScope(sf: ts.SourceFile): boolean {
  if (sf.isDeclarationFile) return false;
  return (
    sf.fileName.includes("/src/") ||
    sf.fileName.includes("\\src\\") ||
    sf.fileName.includes("/scripts/") ||
    sf.fileName.includes("\\scripts\\")
  );
}

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
 * noAssignInExpressions) must NOT match. The directive must lead the line (after
 * a `//`, `/*`, or `*` comment marker) so prose mentions of the rule path inside
 * the gate's own source/tests — now in scope — don't self-trip.
 */
export function findRuleSuppressions(text: string): number[] {
  const re = /^\s*(?:\/\/|\/\*|\*)\s*biome-ignore\s+lint\/nursery\/noFloatingPromises/;
  const lines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (re.test(line)) lines.push(i + 1);
  });
  return lines;
}

/**
 * Both violation kinds across the Program's in-scope source files, reading each
 * file once from its already-loaded `SourceFile.text` (no second disk read):
 *   - `void <promise>` expressions (walked off the type-checker), and
 *   - `biome-ignore lint/nursery/noFloatingPromises` suppressions.
 */
export function scanProgram(program: ts.Program): Violation[] {
  const checker = program.getTypeChecker();
  const out: Violation[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!inScope(sf)) continue;
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
    for (const line of findRuleSuppressions(sf.text)) {
      out.push({ file: sf.fileName, line, kind: "rule-suppression" });
    }
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

export function scanSrc(roots: string | string[] = SCAN_ROOTS): Violation[] {
  const dirs = Array.isArray(roots) ? roots : [roots];
  const files = dirs.flatMap(collectTsFiles);
  return scanProgram(buildProgram(files));
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
