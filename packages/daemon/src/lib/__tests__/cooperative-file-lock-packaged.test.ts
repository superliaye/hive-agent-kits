import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Fixture = {
  executablePath: string;
  fixturePath: string;
  resourcePath: string;
  resultPath: string;
};

function withFixture(work: (fixture: Fixture) => void): void {
  const testDirectory = mkdtempSync(
    join(dirname(fileURLToPath(import.meta.url)), ".packaged-lock-"),
  );
  try {
    const fixture = {
      fixturePath: join(testDirectory, "fixture.ts"),
      executablePath: join(testDirectory, "fixture"),
      resourcePath: join(testDirectory, "manifest.json"),
      resultPath: join(testDirectory, "result.txt"),
    };
    const lockModulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../cooperative-file-lock.ts",
    );
    writeFileSync(
      fixture.fixturePath,
      `import { writeFileSync } from "node:fs";
import { withIndependentFileLock } from ${JSON.stringify(lockModulePath)};

withIndependentFileLock(
  process.env.HIVE_TEST_LOCK_RESOURCE!,
  () => writeFileSync(process.env.HIVE_TEST_LOCK_RESULT!, "completed"),
  { timeoutMs: 4_000, staleMs: 1_000, updateMs: 100 },
);
`,
    );
    work(fixture);
  } finally {
    rmSync(testDirectory, { recursive: true, force: true });
  }
}

function fixtureEnvironment(fixture: Fixture): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.AGENT_MANIFEST_LOCK_PROTOCOL;
  return {
    ...environment,
    HIVE_PACKAGED: "1",
    HIVE_TEST_LOCK_RESOURCE: fixture.resourcePath,
    HIVE_TEST_LOCK_RESULT: fixture.resultPath,
  };
}

function assertFixtureCompleted(fixture: Fixture, executed: ReturnType<typeof spawnSync>): void {
  if (executed.status !== 0) {
    throw new Error(
      `fixture failed (status=${executed.status}, signal=${executed.signal}):\n${executed.stdout}${executed.stderr}`,
    );
  }
  expect(executed.error).toBeUndefined();
  expect(executed.signal).toBeNull();
  expect(readFileSync(fixture.resultPath, "utf8")).toBe("completed");
  expect(existsSync(`${fixture.resourcePath}.lock`)).toBe(false);
}

test("packaged home semantics work under the regular Bun runtime", () => {
  withFixture((fixture) => {
    const executed = spawnSync(process.execPath, [fixture.fixturePath], {
      encoding: "utf8",
      env: fixtureEnvironment(fixture),
      timeout: 10_000,
    });
    assertFixtureCompleted(fixture, executed);
  });
});

test("a compiled executable acquires and releases an independent file lock", () => {
  withFixture((fixture) => {
    const compiled = spawnSync(
      process.execPath,
      ["build", "--compile", fixture.fixturePath, "--outfile", fixture.executablePath],
      { encoding: "utf8" },
    );
    if (compiled.status !== 0) {
      throw new Error(`fixture compilation failed:\n${compiled.stdout}${compiled.stderr}`);
    }

    const executed = spawnSync(fixture.executablePath, [], {
      encoding: "utf8",
      env: fixtureEnvironment(fixture),
      timeout: 10_000,
    });
    assertFixtureCompleted(fixture, executed);
  });
});
