#!/usr/bin/env bun
// capability-validate — the fs-coupled validator bin (ADR-0024: the CLI is the
// one fs-coupled spot). Its only fs touch is importing nodeFsSourceTree. Exit 0
// when conformant, exit 1 when conformance errors are found, so it is CI-usable
// for a starter's self-validation.
//
//   capability-validate <repo-path> [--json]

import { validate } from "./index.ts";
import { nodeFsSourceTree } from "./node.ts";

function main(argv: string[]): number {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const repoPath = args.find((a) => !a.startsWith("--"));

  if (!repoPath) {
    process.stderr.write("usage: capability-validate <repo-path> [--json]\n");
    return 2;
  }

  const tree = nodeFsSourceTree(repoPath);
  const result = validate(tree);

  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    if (result.conformant) {
      process.stdout.write("conformant: no conformance errors found\n");
    } else {
      process.stdout.write(`non-conformant: ${result.errors.length} error(s)\n`);
      for (const e of result.errors) {
        process.stdout.write(`  ${e.kind}:${e.name} — ${e.message}\n`);
      }
    }
  }

  return result.conformant ? 0 : 1;
}

process.exit(main(process.argv));
