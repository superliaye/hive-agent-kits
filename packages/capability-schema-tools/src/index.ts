// @hive/capability-schema-tools — the behavior layer of the capability format
// (ADR-0024): parse (lenient read model) and validate (strict conformance gate)
// over a consumer-owned SourceTree read-port. Pure: depends only on
// @hive/capability-schema (+ zod, yaml); no fs/http/exec/Effect in this core. The
// one fs adapter lives behind the `./node` subpath; the bin behind `./cli`.

export type { SourceTree } from "./source-tree.ts";
export type { LeafHit, WalkProblem, WalkResult } from "./walk.ts";
export { enumerateLeaves } from "./walk.ts";
export {
  parse,
  ParsedCapability,
  ParsedCatalog,
  Problem,
} from "./parse.ts";
export {
  validate,
  ConformanceError,
  ValidationResult,
} from "./validate.ts";
