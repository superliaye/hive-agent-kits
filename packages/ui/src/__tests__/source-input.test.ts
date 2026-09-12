import { describe, expect, test } from "bun:test";
import { sourceInputFromUrl } from "../api.ts";

describe("sourceInputFromUrl", () => {
  test("keeps an ordinary repository URL on the default branch and root", () => {
    expect(sourceInputFromUrl("https://github.com/owner/repo")).toEqual({
      label: "owner/repo",
      locator: {
        kind: "git",
        repoUrl: "https://github.com/owner/repo",
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
    });
  });

  test("converts a GitHub folder URL into its repository, branch, and subpath", () => {
    expect(
      sourceInputFromUrl(
        "https://github.com/databricks-eng/universe/tree/master/experimental/leon-ye_data/dbx-agent-kits",
      ),
    ).toEqual({
      label: "databricks-eng/universe",
      locator: {
        kind: "git",
        repoUrl: "https://github.com/databricks-eng/universe",
        revision: { mode: "track", ref: "refs/heads/master" },
        subpath: "experimental/leon-ye_data/dbx-agent-kits",
      },
    });
  });
});
