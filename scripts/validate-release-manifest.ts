import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateStableReleaseManifestAssets } from "./release-manifest";

const [manifestArg, expectedCommit, assetsArg, assetBaseUrl] = Bun.argv.slice(2);
if (!manifestArg || !expectedCommit || !assetsArg || !assetBaseUrl) {
  throw new Error(
    "usage: validate-release-manifest.ts <stable.json> <expected-commit> <assets-directory> <asset-base-url>",
  );
}

const manifestPath = resolve(manifestArg);
await validateStableReleaseManifestAssets(
  JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  {
    assetsDirectory: resolve(assetsArg),
    expectedCommit,
    assetBaseUrl,
  },
);
