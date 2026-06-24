import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorContentSha } from "../content-sha.ts";
import { skillSourceDir } from "../deploy/sources.ts";

let tmpRoot: string;
let mirrorA: string;
let mirrorB: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "content-sha-"));
  mirrorA = join(tmpRoot, "a");
  mirrorB = join(tmpRoot, "b");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSkill(mirror: string, rel: string, body: string): void {
  const dir = join(mirror, "capabilities", "skills", rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\ndescription: s\n---\n${body}\n`);
}

function writeAgent(mirror: string, name: string, body: string): void {
  const dir = join(mirror, "capabilities", "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "AGENT.md"), `---\ndescription: a\n---\n${body}\n`);
}

function writeFileKind(mirror: string, dir: string, file: string, body: string): void {
  const full = join(mirror, "capabilities", dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, file), body);
}

describe("mirrorContentSha — byte-identical equality across Mirrors, per kind", () => {
  test("skill: identical bytes -> equal sha; one-byte diff -> different", () => {
    writeSkill(mirrorA, "foo", "same body");
    writeSkill(mirrorB, "foo", "same body");
    expect(mirrorContentSha(mirrorA, "skill", "foo")).toBe(
      mirrorContentSha(mirrorB, "skill", "foo"),
    );
    writeSkill(mirrorB, "foo", "same body!");
    expect(mirrorContentSha(mirrorA, "skill", "foo")).not.toBe(
      mirrorContentSha(mirrorB, "skill", "foo"),
    );
  });

  test("agent: identical -> equal; differing -> different", () => {
    writeAgent(mirrorA, "ag", "agent body");
    writeAgent(mirrorB, "ag", "agent body");
    expect(mirrorContentSha(mirrorA, "agent", "ag")).toBe(mirrorContentSha(mirrorB, "agent", "ag"));
    writeAgent(mirrorB, "ag", "agent body changed");
    expect(mirrorContentSha(mirrorA, "agent", "ag")).not.toBe(
      mirrorContentSha(mirrorB, "agent", "ag"),
    );
  });

  test("instruction: identical -> equal; differing -> different", () => {
    writeFileKind(mirrorA, "instructions", "core.instructions.md", "body");
    writeFileKind(mirrorB, "instructions", "core.instructions.md", "body");
    expect(mirrorContentSha(mirrorA, "instruction", "core")).toBe(
      mirrorContentSha(mirrorB, "instruction", "core"),
    );
    writeFileKind(mirrorB, "instructions", "core.instructions.md", "body2");
    expect(mirrorContentSha(mirrorA, "instruction", "core")).not.toBe(
      mirrorContentSha(mirrorB, "instruction", "core"),
    );
  });

  test("plugin: identical -> equal; differing -> different", () => {
    writeFileKind(mirrorA, "plugins", "p.plugin.md", "x");
    writeFileKind(mirrorB, "plugins", "p.plugin.md", "x");
    expect(mirrorContentSha(mirrorA, "plugin", "p")).toBe(mirrorContentSha(mirrorB, "plugin", "p"));
    writeFileKind(mirrorB, "plugins", "p.plugin.md", "y");
    expect(mirrorContentSha(mirrorA, "plugin", "p")).not.toBe(
      mirrorContentSha(mirrorB, "plugin", "p"),
    );
  });

  test("bundle: identical -> equal; differing -> different", () => {
    writeFileKind(mirrorA, "bundles", "b.bundle.md", "x");
    writeFileKind(mirrorB, "bundles", "b.bundle.md", "x");
    expect(mirrorContentSha(mirrorA, "bundle", "b")).toBe(mirrorContentSha(mirrorB, "bundle", "b"));
    writeFileKind(mirrorB, "bundles", "b.bundle.md", "y");
    expect(mirrorContentSha(mirrorA, "bundle", "b")).not.toBe(
      mirrorContentSha(mirrorB, "bundle", "b"),
    );
  });

  test("@group-nested skill hashes equal to the same skill placed flat (path relative to leaf)", () => {
    writeSkill(mirrorA, "@grp/@sub/foo", "identical");
    writeSkill(mirrorB, "foo", "identical");
    expect(mirrorContentSha(mirrorA, "skill", "foo")).toBe(
      mirrorContentSha(mirrorB, "skill", "foo"),
    );
  });

  test("missing file -> null", () => {
    expect(mirrorContentSha(mirrorA, "skill", "nope")).toBeNull();
    expect(mirrorContentSha(mirrorA, "instruction", "nope")).toBeNull();
  });

  test("locator is stateless: a skill added to the SAME mirrorRoot after a first read is found (no stale cache)", () => {
    // A re-sync mutates a Mirror in place under a stable path. The locator must
    // re-walk, never serve a cached pre-sync leaf map.
    expect(skillSourceDir(mirrorA, "late")).toBeNull();
    expect(mirrorContentSha(mirrorA, "skill", "late")).toBeNull();
    writeSkill(mirrorA, "late", "added after first read");
    expect(skillSourceDir(mirrorA, "late")).not.toBeNull();
    expect(mirrorContentSha(mirrorA, "skill", "late")).not.toBeNull();
  });
});
