import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("dev fixture Source launchers", () => {
  test("scripts/dev.ts wires fixture env to daemon and shell and bypasses daemon-only reuse", () => {
    const text = readFileSync(join(ROOT, "scripts", "dev.ts"), "utf8");
    expect(text).toContain("--fixture-sources");
    expect(text).toContain('import { Catalog, KitStateSchema, Source } from "@hive/contract";');
    expect(text).toContain('HIVE_DEV_FIXTURE_SOURCES: "1"');
    expect(text).toContain('HIVE_CLAUDE_HOME: join(homesRoot, ".claude")');
    expect(text).toContain('HIVE_LEDGER_PATH: join(homesRoot, ".agent-kit", "manifest.json")');
    expect(text).toContain('fixtureSources ? ".hive-fixtures" : ".hive"');
    expect(text).toContain("!fixtureSources && (await daemonHealthy())");
    expect(text).toContain("Source.array().parse(await sources.json())");
    expect(text).toContain("KitStateSchema.parse(await state.json())");
    expect(text).toContain("entry.sourceIds.includes(id)");
    expect(text).toContain(
      "env: { HIVE_PORT: String(DAEMON_PORT), HIVE_RUNTIME_ROOT: RUNTIME_ROOT, ...fixtureEnv() }",
    );
    expect(text).toContain("...fixtureEnv(),\n      HIVE_UI_DEV_URL");
  });

  test("scripts/dev.ps1 exposes -FixtureSources and passes fixture env to daemon and shell", () => {
    const text = readFileSync(join(ROOT, "scripts", "dev.ps1"), "utf8");
    expect(text).toContain("[switch]$FixtureSources");
    expect(text).toContain(".hive-fixtures");
    expect(text).toContain("set HIVE_DEV_FIXTURE_SOURCES=1");
    expect(text).toContain("set HIVE_CLAUDE_HOME=");
    expect(text).toContain("set HIVE_LEDGER_PATH=");
    expect(text).toContain("if ($DaemonOnly -and -not $FixtureSources)");
    expect(text).toContain("ConvertFrom-Json");
    expect(text).toContain("$state.sync");
    expect(text).toContain("$catalog.entries");
    expect((text.match(/\$FixtureEnvLines/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(text).toContain("fixtures  {0}");
  });
});
