import { dirname, join } from "node:path";
import type { Source } from "@hive/contract";
import type { DeployTargets } from "./targets.ts";

const STARTER_SOURCE_ID = "starter";
const STARTER_SOURCE_ORIGIN = "local:starter";
const FIXTURE_ORIGIN_PREFIX = "local:fixture-";

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
  if (source.id === STARTER_SOURCE_ID || source.origin === STARTER_SOURCE_ORIGIN) {
    return targets.starterRoot();
  }
  if (source.origin.startsWith(FIXTURE_ORIGIN_PREFIX)) {
    return join(fixtureSourcesRoot(), source.origin.slice(FIXTURE_ORIGIN_PREFIX.length));
  }
  return null;
}
