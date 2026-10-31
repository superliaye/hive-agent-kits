import { describe, expect, test } from "bun:test";
import { sourceInputFromValue } from "../api.ts";

describe("sourceInputFromValue", () => {
  test("keeps an ordinary repository URL on the default branch and root", () => {
    expect(sourceInputFromValue("https://github.com/owner/repo")).toEqual({
      label: "owner/repo",
      locator: {
        kind: "git",
        repoUrl: "https://github.com/owner/repo",
        revision: { mode: "track", ref: "HEAD" },
        subpath: ".",
      },
    });
  });

  test("converts a GitHub folder URL into its repository, branch, and subpath", () => {
    expect(
      sourceInputFromValue(
        "https://github.com/example-org/monorepo/tree/master/tools/team-agent-kits",
      ),
    ).toEqual({
      label: "example-org/monorepo",
      locator: {
        kind: "git",
        repoUrl: "https://github.com/example-org/monorepo",
        revision: { mode: "track", ref: "refs/heads/master" },
        subpath: "tools/team-agent-kits",
      },
    });
  });

  test("converts an absolute Daemon path into a working-tree Source input", () => {
    expect(sourceInputFromValue("/home/dev/monorepo/tools/team-agent-kits")).toEqual({
      label: "team-agent-kits",
      locator: {
        kind: "working-tree",
        repoRoot: "/home/dev/monorepo/tools/team-agent-kits",
        subpath: ".",
      },
    });
  });
});
