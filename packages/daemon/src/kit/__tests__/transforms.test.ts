import { describe, expect, test } from "bun:test";
import {
  expandIncludes,
  type SkillFile,
  transformAgent,
  transformInstructions,
  transformSkill,
} from "../deploy/transforms.ts";

describe("expandIncludes", () => {
  test("replaces a standalone include marker with the snippet body", () => {
    const snippets = new Map([["greeting", "Hello world"]]);
    const out = expandIncludes("<!-- include: greeting -->", snippets, true, "test");
    expect(out).toBe("Hello world");
  });

  test("strict throws on unknown snippet; non-strict leaves the marker", () => {
    const snippets = new Map<string, string>();
    expect(() => expandIncludes("<!-- include: missing -->", snippets, true, "test")).toThrow();
    expect(expandIncludes("<!-- include: missing -->", snippets, false, "test")).toBe(
      "<!-- include: missing -->",
    );
  });
});

describe("transformSkill", () => {
  const snippets = new Map([["body-snip", "EXPANDED BODY"]]);

  test("filters _unshipped/ and SOURCE.md, expands includes in SKILL.md", () => {
    const files: SkillFile[] = [
      { rel: "SKILL.md", content: "---\ndescription: x\n---\n<!-- include: body-snip -->" },
      { rel: "SOURCE.md", content: "maintainer notes" },
      { rel: "_unshipped/notes.md", content: "draft" },
      { rel: "ref/keep.md", content: "kept reference" },
    ];
    const out = transformSkill({ name: "demo", files, disableModelInvocation: false }, snippets);

    const rels = out.files.map((f) => f.rel).sort();
    expect(rels).toEqual(["SKILL.md", "ref/keep.md"]);
    const skill = out.files.find((f) => f.rel === "SKILL.md");
    expect(skill?.content).toContain("EXPANDED BODY");
    expect(skill?.content).not.toContain("<!-- include:");
    expect(out.sidecar).toBeUndefined();
  });

  test("emits agents/openai.yaml sidecar (allow_implicit_invocation:false) when disableModelInvocation", () => {
    const files: SkillFile[] = [{ rel: "SKILL.md", content: "---\ndescription: x\n---\nbody" }];
    const out = transformSkill({ name: "demo", files, disableModelInvocation: true }, snippets);
    expect(out.sidecar).toBeDefined();
    expect(out.sidecar?.rel).toBe("agents/openai.yaml");
    expect(out.sidecar?.content).toContain("allow_implicit_invocation: false");
  });
});

describe("transformAgent", () => {
  const snippets = new Map([["shared", "SHARED TEXT"]]);

  test("claudeMd is verbatim with includes expanded", () => {
    const raw =
      "---\nname: my-agent\ndescription: does things\nmodel: opus\ntools: [Read, Edit]\n---\n# Body\n<!-- include: shared -->\n";
    const out = transformAgent({ name: "my-agent", raw }, snippets);
    expect(out.claudeMd).toContain("# Body");
    expect(out.claudeMd).toContain("SHARED TEXT");
    expect(out.claudeMd).toContain("name: my-agent"); // frontmatter retained verbatim for claude
  });

  test("codexToml carries name/description/developer_instructions and DROPS model + tools", () => {
    const raw =
      "---\nname: my-agent\ndescription: does things\nmodel: opus\ntools: [Read, Edit]\n---\n# Body\nInstructions here.\n";
    const out = transformAgent({ name: "my-agent", raw }, snippets);

    expect(out.codexToml).toContain('name = "my-agent"');
    expect(out.codexToml).toContain('description = "does things"');
    expect(out.codexToml).toContain("developer_instructions =");
    // model + tools from frontmatter must NOT appear as toml keys.
    expect(out.codexToml).not.toMatch(/^model\s*=/m);
    expect(out.codexToml).not.toMatch(/^tools\s*=/m);
    expect(out.codexToml).not.toContain("opus");
    // developer_instructions is the stripped body only (no frontmatter).
    expect(out.codexToml).toContain("Instructions here.");
  });
});

describe("transformInstructions", () => {
  test("strips frontmatter, \\n\\n-joins bodies, trailing newline", () => {
    const a = "---\ndescription: a\n---\nFirst body.";
    const b = "Second body.";
    const out = transformInstructions([a, b]);
    expect(out).toBe("First body.\n\nSecond body.\n");
    expect(out.endsWith("\n")).toBe(true);
    expect(out).not.toContain("description: a");
  });
});
