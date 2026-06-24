import { describe, expect, test } from "bun:test";
import { AddSourceBody, Source } from "./source.ts";

describe("Source — kind discriminator", () => {
  test("accepts a git Source and a local Source", () => {
    expect(
      Source.safeParse({
        id: "id-git",
        origin: "https://github.com/a/b",
        kind: "git",
        active: true,
        createdAt: 1,
      }).success,
    ).toBe(true);
    expect(
      Source.safeParse({
        id: "starter",
        origin: "local:starter",
        kind: "local",
        active: true,
        createdAt: 1,
      }).success,
    ).toBe(true);
  });

  test("rejects an unknown kind and a missing kind", () => {
    expect(
      Source.safeParse({ id: "x", origin: "y", kind: "remote", active: true, createdAt: 1 }).success,
    ).toBe(false);
    expect(Source.safeParse({ id: "x", origin: "y", active: true, createdAt: 1 }).success).toBe(
      false,
    );
  });
});

describe("AddSourceBody — GitHttpsUrl (the public add stays git-only)", () => {
  test("accepts a plain https git URL", () => {
    expect(AddSourceBody.safeParse({ origin: "https://github.com/a/b" }).success).toBe(true);
    expect(AddSourceBody.safeParse({ origin: "https://github.com/a/b.git" }).success).toBe(true);
  });

  test("rejects non-https schemes", () => {
    expect(AddSourceBody.safeParse({ origin: "mailto:x@y" }).success).toBe(false);
    expect(AddSourceBody.safeParse({ origin: "ftp://example.com/repo" }).success).toBe(false);
    expect(AddSourceBody.safeParse({ origin: "http://github.com/a/b" }).success).toBe(false);
    expect(AddSourceBody.safeParse({ origin: "git@github.com:a/b.git" }).success).toBe(false);
  });

  test("rejects a URL carrying embedded credentials", () => {
    expect(AddSourceBody.safeParse({ origin: "https://user:token@github.com/a/b" }).success).toBe(
      false,
    );
    expect(AddSourceBody.safeParse({ origin: "https://user@github.com/a/b" }).success).toBe(false);
  });

  test("rejects a non-URL string", () => {
    expect(AddSourceBody.safeParse({ origin: "not a url" }).success).toBe(false);
  });
});
