import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const FullCommit = z.string().regex(/^[0-9a-f]{40}$/);
const SafeComponent = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const CredentialFreeHttpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  }, "URL must be credential-free HTTPS");

export const ReleaseMetadataSchema = z
  .object({
    releaseId: z.string().regex(/^g[0-9a-f]{40}$/),
    buildVersion: SafeComponent,
    sourceCommit: FullCommit,
    protocolRange: z.literal("1"),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.releaseId !== `g${metadata.sourceCommit}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["releaseId"],
        message: "releaseId must identify sourceCommit",
      });
    }
  });

export type ReleaseMetadata = z.infer<typeof ReleaseMetadataSchema>;

const ArtifactFields = {
  url: CredentialFreeHttpsUrl,
  sha256: Sha256,
  sizeBytes: z.number().int().positive(),
};

const ReleaseArtifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shell"),
      platform: z.literal("darwin"),
      architecture: z.enum(["arm64", "x64"]),
      format: z.literal("tar.gz"),
      ...ArtifactFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("daemon"),
      platform: z.literal("linux"),
      architecture: z.literal("x64"),
      format: z.literal("executable"),
      ...ArtifactFields,
    })
    .strict(),
]);

const expectedArtifactKeys = [
  "shell/darwin/arm64",
  "shell/darwin/x64",
  "daemon/linux/x64",
] as const;

export const StableReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal("stable"),
    release: z
      .object({
        releaseId: z.string().regex(/^g[0-9a-f]{40}$/),
        buildVersion: SafeComponent,
        source: z
          .object({
            repository: CredentialFreeHttpsUrl,
            commit: FullCommit,
          })
          .strict(),
        protocolRange: z.literal("1"),
        publishedAt: z.string().datetime({ offset: false }),
        artifacts: z.array(ReleaseArtifactSchema).length(3),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.release.releaseId !== `g${manifest.release.source.commit}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["release", "releaseId"],
        message: "releaseId must identify the source commit",
      });
    }
    const keys = manifest.release.artifacts.map(
      (artifact) => `${artifact.kind}/${artifact.platform}/${artifact.architecture}`,
    );
    if (
      new Set(keys).size !== expectedArtifactKeys.length ||
      !expectedArtifactKeys.every((key) => keys.includes(key))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["release", "artifacts"],
        message: "release must contain the exact supported artifact matrix",
      });
    }
  });

export type StableReleaseManifest = z.infer<typeof StableReleaseManifestSchema>;

const releaseEnvironmentKeys = [
  "HIVE_RELEASE_ID",
  "HIVE_RELEASE_BUILD_VERSION",
  "HIVE_RELEASE_SOURCE_COMMIT",
  "HIVE_RELEASE_PROTOCOL_RANGE",
] as const;

export function readReleaseMetadata(
  environment: Record<string, string | undefined>,
  fallbackCommit: string,
): ReleaseMetadata {
  const supplied = releaseEnvironmentKeys.filter((key) => environment[key] !== undefined);
  if (supplied.length === 0) {
    FullCommit.parse(fallbackCommit);
    return ReleaseMetadataSchema.parse({
      releaseId: `g${fallbackCommit}`,
      buildVersion: `0.0.0-g${fallbackCommit.slice(0, 12)}-local`,
      sourceCommit: fallbackCommit,
      protocolRange: "1",
    });
  }
  if (supplied.length !== releaseEnvironmentKeys.length) {
    throw new Error("release metadata environment must be complete");
  }
  return ReleaseMetadataSchema.parse({
    releaseId: environment.HIVE_RELEASE_ID,
    buildVersion: environment.HIVE_RELEASE_BUILD_VERSION,
    sourceCommit: environment.HIVE_RELEASE_SOURCE_COMMIT,
    protocolRange: environment.HIVE_RELEASE_PROTOCOL_RANGE,
  });
}

type ArtifactDefinition = {
  fileName: string;
  kind: "shell" | "daemon";
  platform: "darwin" | "linux";
  architecture: "arm64" | "x64";
  format: "tar.gz" | "executable";
};

const artifactDefinitions: ArtifactDefinition[] = [
  {
    fileName: "Hive-darwin-arm64.tar.gz",
    kind: "shell",
    platform: "darwin",
    architecture: "arm64",
    format: "tar.gz",
  },
  {
    fileName: "Hive-darwin-x64.tar.gz",
    kind: "shell",
    platform: "darwin",
    architecture: "x64",
    format: "tar.gz",
  },
  {
    fileName: "hive-daemon-linux-x64",
    kind: "daemon",
    platform: "linux",
    architecture: "x64",
    format: "executable",
  },
];

async function fileIdentity(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`release artifact is not a non-empty regular file: ${path}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), sizeBytes: fileStat.size };
}

export type CreateStableReleaseManifestInput = {
  assetsDirectory: string;
  repository: string;
  commit: string;
  buildVersion: string;
  publishedAt: string;
  assetBaseUrl: string;
};

export async function createStableReleaseManifest(
  input: CreateStableReleaseManifestInput,
): Promise<StableReleaseManifest> {
  const baseUrl = CredentialFreeHttpsUrl.parse(input.assetBaseUrl);
  const artifacts = await Promise.all(
    artifactDefinitions.map(async (definition) => ({
      kind: definition.kind,
      platform: definition.platform,
      architecture: definition.architecture,
      format: definition.format,
      url: new URL(definition.fileName, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href,
      ...(await fileIdentity(join(input.assetsDirectory, definition.fileName))),
    })),
  );
  return StableReleaseManifestSchema.parse({
    schemaVersion: 1,
    channel: "stable",
    release: {
      releaseId: `g${input.commit}`,
      buildVersion: input.buildVersion,
      source: { repository: input.repository, commit: input.commit },
      protocolRange: "1",
      publishedAt: input.publishedAt,
      artifacts,
    },
  });
}
