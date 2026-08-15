import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createStableReleaseManifest } from "./release-manifest";

type Options = {
  assets: string;
  output: string;
  repository: string;
  commit: string;
  buildVersion: string;
  publishedAt: string;
  assetBaseUrl: string;
};

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("release manifest options must be --name value pairs");
    }
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const required = [
    "--assets",
    "--output",
    "--repository",
    "--commit",
    "--build-version",
    "--published-at",
    "--asset-base-url",
  ];
  const unknown = [...values.keys()].filter((key) => !required.includes(key));
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown[0]}`);
  for (const key of required) {
    if (!values.has(key)) throw new Error(`missing option: ${key}`);
  }
  return {
    assets: resolve(values.get("--assets") as string),
    output: resolve(values.get("--output") as string),
    repository: values.get("--repository") as string,
    commit: values.get("--commit") as string,
    buildVersion: values.get("--build-version") as string,
    publishedAt: values.get("--published-at") as string,
    assetBaseUrl: values.get("--asset-base-url") as string,
  };
}

const options = parseOptions(Bun.argv.slice(2));
const manifest = await createStableReleaseManifest({
  assetsDirectory: options.assets,
  repository: options.repository,
  commit: options.commit,
  buildVersion: options.buildVersion,
  publishedAt: options.publishedAt,
  assetBaseUrl: options.assetBaseUrl,
});
await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
