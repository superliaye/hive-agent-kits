import { describe, expect, test } from "bun:test";
import { redactString, redactValue } from "../redaction.ts";

describe("redactString", () => {
  test("masks anthropic api keys", () => {
    expect(redactString("my key is sk-ant-abcdefghijklmnopqrstuv")).toBe(
      "my key is [REDACTED:anthropic-api]",
    );
  });

  test("masks openai api keys", () => {
    expect(redactString("openai sk-1234567890abcdefghij")).toContain("[REDACTED:openai-api]");
  });

  test("masks github tokens of every prefix", () => {
    for (const prefix of ["ghp_", "ghs_", "gho_", "ghr_", "ghu_", "gha_"]) {
      const tok = `${prefix}abcdefghij1234567890`;
      expect(redactString(`token: ${tok}`)).toContain("[REDACTED:github-token]");
    }
  });

  test("masks aws access keys", () => {
    expect(redactString("creds AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED:aws-access-key]");
  });

  test("masks google api keys", () => {
    expect(redactString("AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI here")).toContain(
      "[REDACTED:google-api]",
    );
  });

  test("masks slack bot/user tokens", () => {
    for (const prefix of ["xoxb-", "xoxp-"]) {
      const tok = `${prefix}123456789-abcdefghij`;
      expect(redactString(`bot: ${tok}`)).toContain("[REDACTED:slack-token]");
    }
  });

  test("leaves plain text untouched", () => {
    expect(redactString("hello world, nothing secret here")).toBe(
      "hello world, nothing secret here",
    );
  });

  test("masks multiple secrets in one string", () => {
    const out = redactString("first sk-ant-aaaaaaaaaaaaaaaaaaaaa second ghp_bbbbbbbbbbbbbbbbbbbb");
    expect(out).toContain("[REDACTED:anthropic-api]");
    expect(out).toContain("[REDACTED:github-token]");
  });

  test("masks JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactString(`Authorization: Bearer ${jwt}`)).toContain("[REDACTED:jwt]");
  });

  test("masks URL passwords while preserving scheme and user", () => {
    const out = redactString("connect: postgres://dbuser:secretpass@db.example.com:5432/mydb");
    expect(out).toContain("postgres://dbuser:");
    expect(out).toContain("[REDACTED:url-password]@");
    expect(out).not.toContain("secretpass");
    expect(out).toContain("db.example.com:5432/mydb");
  });

  test("masks URL passwords across schemes", () => {
    for (const scheme of ["postgres", "mysql", "mongodb", "redis", "https"]) {
      const out = redactString(`${scheme}://u:p4ssw0rd-secret@host`);
      expect(out).toContain(`${scheme}://u:[REDACTED:url-password]@host`);
    }
  });
});

describe("redactValue", () => {
  test("recurses into nested objects", () => {
    const out = redactValue({ outer: { inner: "ghp_abcdefghij1234567890" } });
    expect(out).toEqual({ outer: { inner: "[REDACTED:github-token]" } });
  });

  test("recurses into arrays including nested arrays", () => {
    const out = redactValue([
      "safe",
      "ghp_abcdefghij1234567890",
      { nested: "ghp_xxxxxxxxxxxxxxxxxxxx" },
      ["deeper", "ghp_yyyyyyyyyyyyyyyyyyyy"],
    ]);
    expect(out).toEqual([
      "safe",
      "[REDACTED:github-token]",
      { nested: "[REDACTED:github-token]" },
      ["deeper", "[REDACTED:github-token]"],
    ]);
  });

  test("preserves non-string primitives", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(undefined)).toBe(undefined);
  });

  test("does not mutate the input", () => {
    const input = { token: "ghp_abcdefghij1234567890" };
    const out = redactValue(input);
    expect(input.token).toBe("ghp_abcdefghij1234567890");
    expect((out as { token: string }).token).toBe("[REDACTED:github-token]");
  });
});
