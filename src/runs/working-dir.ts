// Per-Run Working Directory resolution (ADR-0016 C4). The three-tier resolver,
// re-homed out of the deleted native `run-shell.ts`:
//   1. per-conversation — the Thread's `working_dir` pick
//   2. agent default    — the Agent's `config.workingDir`
//   3. per-Agent `~/.hive` workspace fallback
// Empty/absent values fall through. Resolved ONCE by the executor (the only
// scope holding both thread + agent) and passed into the backend invocation.

import { join } from "node:path";
import { runtimeRoot } from "../lib/paths.ts";

export function resolveWorkingDir(input: {
  agentId: string;
  threadWorkingDir?: string | null;
  agentDefaultWorkingDir?: string;
}): string {
  const tier1 =
    typeof input.threadWorkingDir === "string" && input.threadWorkingDir.length > 0
      ? input.threadWorkingDir
      : undefined;
  const tier2 =
    typeof input.agentDefaultWorkingDir === "string" && input.agentDefaultWorkingDir.length > 0
      ? input.agentDefaultWorkingDir
      : undefined;
  return tier1 ?? tier2 ?? join(runtimeRoot(), "agents", input.agentId, "workspace");
}
