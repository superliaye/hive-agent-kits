import { describe, expect, test } from "bun:test";
import { AddSourceBody } from "./source.ts";

describe("AddSourceBody — GitHttpsUrl", () => {
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
