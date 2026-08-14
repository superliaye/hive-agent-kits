import { describe, expect, test } from "bun:test";
import { AddSourceBody, Source, SourceLocator } from "./source.ts";

describe("SourceLocator", () => {
  test("accepts tracked and pinned git subpaths", () => {
    expect(
      SourceLocator.safeParse({
        kind: "git",
        repoUrl: "https://github.com/databricks-eng/universe",
        revision: { mode: "track", ref: "refs/heads/master" },
        subpath: "experimental/leon-ye_data/agent-kits",
      }).success,
    ).toBe(true);
    expect(
      SourceLocator.safeParse({
        kind: "git",
        repoUrl: "https://github.com/superliaye/my-agent-kits",
        revision: { mode: "pin", commit: "a".repeat(40) },
        subpath: ".",
      }).success,
    ).toBe(true);
  });

  test("rejects ambiguous refs, traversal, and credential-bearing repositories", () => {
    expect(
      SourceLocator.safeParse({
        kind: "git",
        repoUrl: "https://github.com/a/b",
        revision: { mode: "track", ref: "main" },
        subpath: ".",
      }).success,
    ).toBe(false);
    expect(
      SourceLocator.safeParse({
        kind: "git",
        repoUrl: "https://github.com/a/b",
        revision: { mode: "track", ref: "refs/heads/mäin" },
        subpath: ".",
      }).success,
    ).toBe(false);
    expect(
      SourceLocator.safeParse({
        kind: "git",
        repoUrl: "https://github.com/a/b",
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: "../outside",
      }).success,
    ).toBe(false);
    expect(
      SourceLocator.safeParse({
        kind: "git",
        repoUrl: "https://user:token@github.com/a/b",
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      }).success,
    ).toBe(false);
  });

  test("accepts a Daemon-host working-tree subpath", () => {
    expect(
      SourceLocator.safeParse({
        kind: "working-tree",
        repoRoot: "/home/leon.ye/universe",
        subpath: "experimental/leon-ye_data/agent-kits",
      }).success,
    ).toBe(true);
  });
});

describe("Source — kind discriminator", () => {
  test("accepts a git Source and a local Source", () => {
    expect(
      Source.safeParse({
        id: "id-git",
        label: "Git",
        locator: {
          kind: "git",
          repoUrl: "https://github.com/a/b",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
        origin: "https://github.com/a/b",
        kind: "git",
        active: true,
        createdAt: 1,
        rank: 1,
      }).success,
    ).toBe(true);
    expect(
      Source.safeParse({
        id: "starter",
        label: "Starter",
        locator: { kind: "starter" },
        origin: "local:starter",
        kind: "local",
        active: true,
        createdAt: 1,
        rank: 0,
      }).success,
    ).toBe(true);
  });

  test("rejects an unknown kind and a missing kind", () => {
    expect(
      Source.safeParse({ id: "x", origin: "y", kind: "remote", active: true, createdAt: 1, rank: 0 })
        .success,
    ).toBe(false);
    expect(
      Source.safeParse({ id: "x", origin: "y", active: true, createdAt: 1, rank: 0 }).success,
    ).toBe(false);
  });

  test("requires rank (the stored precedence signal)", () => {
    expect(
      Source.safeParse({
        id: "x",
        origin: "https://github.com/a/b",
        kind: "git",
        active: true,
        createdAt: 1,
      }).success,
    ).toBe(false);
  });
});

describe("AddSourceBody", () => {
  test("accepts a labeled locator", () => {
    expect(
      AddSourceBody.safeParse({
        label: "Universe personal kit",
        locator: {
          kind: "git",
          repoUrl: "https://github.com/databricks-eng/universe",
          revision: { mode: "track", ref: "refs/heads/master" },
          subpath: "experimental/leon-ye_data/agent-kits",
        },
      }).success,
    ).toBe(true);
  });
  test("requires the labeled locator transport shape", () => {
    expect(AddSourceBody.safeParse({ origin: "https://github.com/a/b" }).success).toBe(false);
    expect(AddSourceBody.safeParse({ origin: "https://github.com/a/b.git" }).success).toBe(false);
  });

  test("rejects non-https git repositories", () => {
    for (const repoUrl of [
      "mailto:x@y",
      "ftp://example.com/repo",
      "http://github.com/a/b",
      "git@github.com:a/b.git",
    ]) {
      expect(
        AddSourceBody.safeParse({
          label: "Invalid",
          locator: {
            kind: "git",
            repoUrl,
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
        }).success,
      ).toBe(false);
    }
  });

  test("rejects a URL carrying embedded credentials", () => {
    for (const repoUrl of [
      "https://user:token@github.com/a/b",
      "https://user@github.com/a/b",
    ]) {
      expect(
        AddSourceBody.safeParse({
          label: "Invalid",
          locator: {
            kind: "git",
            repoUrl,
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
        }).success,
      ).toBe(false);
    }
  });

  test("rejects a non-URL string", () => {
    expect(
      AddSourceBody.safeParse({
        label: "Invalid",
        locator: {
          kind: "git",
          repoUrl: "not a url",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
      }).success,
    ).toBe(false);
  });
});
