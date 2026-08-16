import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStableReleaseManifest,
  ReleaseMetadataSchema,
  readReleaseMetadata,
  StableReleaseManifestSchema,
  validateStableReleaseManifestAssets,
} from "../release-manifest";

const commit = "0123456789abcdef0123456789abcdef01234567";
const repository = "https://github.com/superliaye/hive-agent-kits.git";
const assetBaseUrl = `https://github.com/superliaye/hive-agent-kits/releases/download/hive-g${commit}/`;
const created: string[] = [];

function assets(): string {
  const directory = mkdtempSync(join(tmpdir(), "hive-release-manifest-test."));
  created.push(directory);
  writeFileSync(join(directory, "Hive-darwin-arm64.tar.gz"), "arm-shell");
  writeFileSync(join(directory, "Hive-darwin-x64.tar.gz"), "x64-shell");
  writeFileSync(join(directory, "hive-daemon-linux-x64"), "daemon");
  return directory;
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release metadata", () => {
  test("requires release identity to name the exact source commit", () => {
    expect(
      ReleaseMetadataSchema.parse({
        releaseId: `g${commit}`,
        buildVersion: "0.0.0-g0123456789ab",
        sourceCommit: commit,
        protocolRange: "1",
      }),
    ).toEqual({
      releaseId: `g${commit}`,
      buildVersion: "0.0.0-g0123456789ab",
      sourceCommit: commit,
      protocolRange: "1",
    });

    expect(() =>
      ReleaseMetadataSchema.parse({
        releaseId: `g${"f".repeat(40)}`,
        buildVersion: "0.0.0-g0123456789ab",
        sourceCommit: commit,
        protocolRange: "1",
      }),
    ).toThrow();
  });

  test("reads complete CI metadata and rejects partial release environments", () => {
    expect(
      readReleaseMetadata(
        {
          HIVE_RELEASE_ID: `g${commit}`,
          HIVE_RELEASE_BUILD_VERSION: "0.0.0-g0123456789ab",
          HIVE_RELEASE_SOURCE_COMMIT: commit,
          HIVE_RELEASE_PROTOCOL_RANGE: "1",
        },
        commit,
      ),
    ).toEqual({
      releaseId: `g${commit}`,
      buildVersion: "0.0.0-g0123456789ab",
      sourceCommit: commit,
      protocolRange: "1",
    });

    expect(() => readReleaseMetadata({ HIVE_RELEASE_ID: `g${commit}` }, commit)).toThrow(
      "release metadata environment must be complete",
    );
    expect(() =>
      readReleaseMetadata(
        {
          HIVE_RELEASE_ID: `g${commit}`,
          HIVE_RELEASE_BUILD_VERSION: "0.0.0-g0123456789ab",
          HIVE_RELEASE_SOURCE_COMMIT: commit,
          HIVE_RELEASE_PROTOCOL_RANGE: "1",
        },
        "f".repeat(40),
      ),
    ).toThrow("release metadata source commit does not match the build tree");
  });

  test("local packaging uses an explicit non-stable build version", () => {
    expect(readReleaseMetadata({}, commit)).toEqual({
      releaseId: `g${commit}`,
      buildVersion: "0.0.0-g0123456789ab-local",
      sourceCommit: commit,
      protocolRange: "1",
    });
  });
});

describe("stable release manifest", () => {
  test("hashes the exact supported artifact matrix", async () => {
    const directory = assets();
    const manifest = await createStableReleaseManifest({
      assetsDirectory: directory,
      repository,
      commit,
      buildVersion: "0.0.0-g0123456789ab",
      publishedAt: "2026-08-15T12:00:00Z",
      assetBaseUrl,
    });

    expect(manifest.release.releaseId).toBe(`g${commit}`);
    expect(
      manifest.release.artifacts.map(({ kind, platform, architecture }) => [
        kind,
        platform,
        architecture,
      ]),
    ).toEqual([
      ["shell", "darwin", "arm64"],
      ["shell", "darwin", "x64"],
      ["daemon", "linux", "x64"],
    ]);
    expect(manifest.release.artifacts[0]?.sizeBytes).toBe(9);
    expect(manifest.release.artifacts[0]?.sha256).toBe(
      createHash("sha256").update("arm-shell").digest("hex"),
    );
    expect(StableReleaseManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test("rejects unknown keys, credential-bearing URLs, and incomplete matrices", async () => {
    const manifest = await createStableReleaseManifest({
      assetsDirectory: assets(),
      repository,
      commit,
      buildVersion: "0.0.0-g0123456789ab",
      publishedAt: "2026-08-15T12:00:00Z",
      assetBaseUrl,
    });

    expect(StableReleaseManifestSchema.safeParse({ ...manifest, unexpected: true }).success).toBe(
      false,
    );
    expect(
      StableReleaseManifestSchema.safeParse({
        ...manifest,
        release: {
          ...manifest.release,
          artifacts: manifest.release.artifacts.map((artifact, index) =>
            index === 0 ? { ...artifact, url: "https://user:secret@example.test/app" } : artifact,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      StableReleaseManifestSchema.safeParse({
        ...manifest,
        release: { ...manifest.release, artifacts: manifest.release.artifacts.slice(1) },
      }).success,
    ).toBe(false);
  });

  test("binds published metadata to the expected release URLs and local asset bytes", async () => {
    const directory = assets();
    const manifest = await createStableReleaseManifest({
      assetsDirectory: directory,
      repository,
      commit,
      buildVersion: "0.0.0-g0123456789ab",
      publishedAt: "2026-08-15T12:00:00Z",
      assetBaseUrl,
    });
    await expect(
      validateStableReleaseManifestAssets(manifest, {
        assetsDirectory: directory,
        expectedCommit: commit,
        assetBaseUrl,
      }),
    ).resolves.toEqual(manifest);

    const first = manifest.release.artifacts[0];
    if (!first) throw new Error("test manifest is missing its first artifact");
    for (const artifact of [
      { ...first, sha256: "0".repeat(64) },
      { ...first, sizeBytes: first.sizeBytes + 1 },
      { ...first, url: `${assetBaseUrl}wrong-name` },
    ]) {
      await expect(
        validateStableReleaseManifestAssets(
          {
            ...manifest,
            release: {
              ...manifest.release,
              artifacts: [artifact, ...manifest.release.artifacts.slice(1)],
            },
          },
          { assetsDirectory: directory, expectedCommit: commit, assetBaseUrl },
        ),
      ).rejects.toThrow();
    }
  });
});
