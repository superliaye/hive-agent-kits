import { describe, expect, test } from "bun:test";
import { sourceInputFromValue } from "../api.ts";

describe("sourceInputFromValue", () => {
  test("keeps an ordinary repository URL on the default branch and root", () => {
    expect(sourceInputFromValue("https://github.com/owner/repo")).toEqual({
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
      sourceInputFromValue(
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

  test("converts an absolute Daemon path into a working-tree Source input", () => {
    expect(
      sourceInputFromValue("/home/leon.ye/universe/experimental/leon-ye_data/dbx-agent-kits"),
    ).toEqual({
      label: "dbx-agent-kits",
      locator: {
        kind: "working-tree",
        repoRoot: "/home/leon.ye/universe/experimental/leon-ye_data/dbx-agent-kits",
        subpath: ".",
      },
    });
  });
});
