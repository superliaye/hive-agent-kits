import { dirname, join } from "node:path";
import type { Source } from "@hive/contract";
import type { DeployTargets } from "./targets.ts";

const STARTER_SOURCE_ID = "starter";
const FIXTURE_SOURCE_ID_PREFIX = "fixture-";

function envOr(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.length > 0 ? value : fallback;
}

export function fixtureSourcesRoot(): string {
  return envOr(
    "HIVE_FIXTURE_SOURCES_ROOT",
    join(dirname(dirname(dirname(import.meta.dir))), "agent-kit-fixture-sources", "sources"),
  );
}

export function localSourceRootFor(source: Source, targets: DeployTargets): string | null {
  if (source.locator.kind !== "starter") return null;
  if (source.id === STARTER_SOURCE_ID) {
    return targets.starterRoot();
  }
  if (source.id.startsWith(FIXTURE_SOURCE_ID_PREFIX)) {
    return join(fixtureSourcesRoot(), source.id.slice(FIXTURE_SOURCE_ID_PREFIX.length));
  }
  return null;
}
