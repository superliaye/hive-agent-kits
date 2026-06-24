import { describe, expect, test } from "bun:test";
import { memTree } from "./mem-tree.ts";
import { validate } from "./validate.ts";

function skill(fm: string, body = "body"): string {
  return `---\n${fm}\n---\n${body}\n`;
}

describe("validate (strict)", () => {
  test("a conformant skill repo is conformant with no errors", () => {
    const tree = memTree({
      "skills/ok-skill/SKILL.md": skill("name: ok-skill\ndescription: a fine skill"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a grouped skill validates name against the innermost dir, not the @-group", () => {
    const tree = memTree({
      "skills/@my/ok-skill/SKILL.md": skill("name: ok-skill\ndescription: grouped"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("uppercase name is a located conformance error", () => {
    const tree = memTree({
      "skills/Bad/SKILL.md": skill("name: Bad\ndescription: nope"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => e.kind === "skill" && e.name === "Bad")).toBe(true);
  });

  test("reserved word `claude` in name is rejected", () => {
    const tree = memTree({
      "skills/claude-helper/SKILL.md": skill("name: claude-helper\ndescription: nope"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => /reserved/.test(e.message))).toBe(true);
  });

  test("unknown frontmatter key is rejected (strict object)", () => {
    const tree = memTree({
      "skills/extra-key/SKILL.md": skill("name: extra-key\ndescription: x\nbogus: y"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => e.name === "extra-key")).toBe(true);
  });

  test("name != dir is a located error (assertNameMatchesDir caught, never thrown)", () => {
    const tree = memTree({
      "skills/dirname/SKILL.md": skill("name: othername\ndescription: x"),
    });
    let threw = false;
    let result: ReturnType<typeof validate> | undefined;
    try {
      result = validate(tree);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.conformant).toBe(false);
    expect(result?.errors.some((e) => /must match its parent directory/.test(e.message))).toBe(true);
  });

  test("a repo with each violation reports one located error per violation", () => {
    const tree = memTree({
      "skills/Up/SKILL.md": skill("name: Up\ndescription: x"),
      "skills/claude-x/SKILL.md": skill("name: claude-x\ndescription: x"),
      "skills/keyed/SKILL.md": skill("name: keyed\ndescription: x\nbogus: y"),
      "skills/dirA/SKILL.md": skill("name: dirB\ndescription: x"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => e.name === "Up")).toBe(true);
    expect(result.errors.some((e) => e.name === "claude-x")).toBe(true);
    expect(result.errors.some((e) => e.name === "keyed")).toBe(true);
    expect(result.errors.some((e) => e.name === "dirA")).toBe(true);
  });

  test("non-skill kinds are not strictly gated in this slice", () => {
    const tree = memTree({
      "plugins/Anything.plugin.md": skill("name: WHATEVER\ndescription: loose"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
  });
});
