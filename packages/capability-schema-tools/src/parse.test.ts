import { describe, expect, test } from "bun:test";
import { memTree } from "./mem-tree.ts";
import { parse } from "./parse.ts";

function skill(fm: string, body = "body"): string {
  return `---\n${fm}\n---\n${body}\n`;
}

describe("parse (lenient)", () => {
  test("multi-level @-group flattens to leaf + group path", () => {
    const tree = memTree({
      "skills/@grp/@sub/foo/SKILL.md": skill("description: nested foo"),
    });
    const cat = parse(tree);
    const foo = cat.capabilities.find((c) => c.kind === "skill" && c.name === "foo");
    expect(foo).toBeDefined();
    expect(foo?.name).toBe("foo");
    expect(foo?.group).toBe("@grp/@sub");
    expect(foo?.resolvable).toBe(true);
    expect(foo?.description).toBe("nested foo");
  });

  test("dot-prefixed child dir is skipped", () => {
    const tree = memTree({
      "skills/.hidden/SKILL.md": skill("description: hidden"),
      "skills/visible/SKILL.md": skill("description: visible"),
    });
    const cat = parse(tree);
    expect(cat.capabilities.some((c) => c.name === "hidden")).toBe(false);
    expect(cat.capabilities.some((c) => c.name === "visible")).toBe(true);
  });

  test("within-kind collision marks all members not-resolvable with verbatim problem", () => {
    const tree = memTree({
      "skills/@a/foo/SKILL.md": skill("description: a-foo"),
      "skills/@b/foo/SKILL.md": skill("description: b-foo"),
    });
    const cat = parse(tree);
    const foos = cat.capabilities.filter((c) => c.kind === "skill" && c.name === "foo");
    expect(foos.length).toBe(2);
    for (const f of foos) {
      expect(f.resolvable).toBe(false);
      expect(f.collisionReason).toBeDefined();
    }
    expect(
      cat.problems.some(
        (p) =>
          p.kind === "skill" &&
          p.name === "foo" &&
          p.problem === "within-kind leaf-name collision — un-deployable",
      ),
    ).toBe(true);
  });

  test("a single file-marker entry is resolvable", () => {
    // Two same-stem `.plugin.md` files cannot coexist in one dir (filenames are
    // unique), so a file-marker within-kind collision is structurally
    // unrepresentable; the within-kind collision pass is shared with folders
    // (covered above) and applies identically by (kind,name).
    const tree = memTree({ "plugins/dup.plugin.md": skill("description: one") });
    const cat = parse(tree);
    const dup = cat.capabilities.find((c) => c.kind === "plugin" && c.name === "dup");
    expect(dup?.resolvable).toBe(true);
  });

  test("a directory named like a marker suffix is ignored", () => {
    const tree = memTree({
      "plugins/x.plugin.md/inner.txt": "not a plugin",
      "plugins/real.plugin.md": skill("description: real"),
    });
    const cat = parse(tree);
    expect(cat.capabilities.some((c) => c.kind === "plugin" && c.name === "x")).toBe(false);
    expect(cat.capabilities.some((c) => c.kind === "plugin" && c.name === "real")).toBe(true);
  });

  test("malformed frontmatter is skipped to empty description, not thrown", () => {
    const tree = memTree({
      "skills/broken/SKILL.md": skill("description: [unterminated\n  bad: : :"),
      "skills/good/SKILL.md": skill("description: good"),
    });
    const cat = parse(tree);
    const broken = cat.capabilities.find((c) => c.name === "broken");
    expect(broken).toBeDefined();
    expect(broken?.description).toBe("");
    expect(cat.capabilities.some((c) => c.name === "good")).toBe(true);
  });

  test("present-but-unreadable marker yields an `unreadable` problem and is not recursed", () => {
    const tree = memTree({
      "skills/badmarker/SKILL.md": null,
    });
    const cat = parse(tree);
    expect(cat.capabilities.some((c) => c.name === "badmarker")).toBe(false);
    expect(
      cat.problems.some((p) => p.kind === "skill" && p.problem.startsWith("unreadable")),
    ).toBe(true);
  });

  test("file-marker kinds are named by suffix-strip", () => {
    const tree = memTree({
      "instructions/my-style.instructions.md": skill("description: style"),
      "bundles/pack.bundle.md": skill("description: pack"),
    });
    const cat = parse(tree);
    expect(cat.capabilities.some((c) => c.kind === "instruction" && c.name === "my-style")).toBe(
      true,
    );
    expect(cat.capabilities.some((c) => c.kind === "bundle" && c.name === "pack")).toBe(true);
  });

  test("result uses format-native field names (resolvable/collisionReason)", () => {
    const tree = memTree({ "skills/solo/SKILL.md": skill("description: solo") });
    const cat = parse(tree);
    const solo = cat.capabilities[0];
    expect(solo).toHaveProperty("resolvable");
    expect(solo).not.toHaveProperty("deployable");
    expect(solo).not.toHaveProperty("blockedReason");
  });
});
