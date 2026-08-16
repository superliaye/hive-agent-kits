import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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

  test("unknown frontmatter key is conformant (passthrough superset)", () => {
    const tree = memTree({
      "skills/extra-key/SKILL.md": skill("name: extra-key\ndescription: x\nbogus: y"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a name-less skill is conformant (effective name = directory)", () => {
    const tree = memTree({
      "skills/nameless/SKILL.md": skill("description: just a description"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a name-less skill in a dir a declared name would mismatch is STILL conformant (skip path)", () => {
    // dir `foo`, no `name` — a declared `name: bar` here would be a name!=dir error,
    // but with name absent the dir-match gate must not fire.
    const tree = memTree({
      "skills/foo/SKILL.md": skill("description: nameless, trusts the directory"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a blank `name:` (YAML null) is conformant — treated like absent, no dir-match", () => {
    // dir `bar`, bare `name:` → null. Must defer to the directory, not error on a
    // null name and not assert name==dir.
    const tree = memTree({
      "skills/bar/SKILL.md": skill("name:\ndescription: blank name defers to dir"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
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
      "skills/dirA/SKILL.md": skill("name: dirB\ndescription: x"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => e.name === "Up")).toBe(true);
    expect(result.errors.some((e) => e.name === "claude-x")).toBe(true);
    expect(result.errors.some((e) => e.name === "dirA")).toBe(true);
  });

});

describe("validate (strict) — agent gating", () => {
  function agent(fm: string): string {
    return `---\n${fm}\n---\nagent body\n`;
  }

  test("a conformant agent is conformant with no errors", () => {
    const tree = memTree({
      "agents/ok-agent/AGENT.md": agent("name: ok-agent\ndescription: a fine agent"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a name-less agent is conformant (effective name = directory)", () => {
    const tree = memTree({
      "agents/nameless/AGENT.md": agent("description: trusts the directory"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("an @-group agent validates name against the innermost dir, not @grp", () => {
    const tree = memTree({
      "agents/@grp/ok-agent/AGENT.md": agent("name: ok-agent\ndescription: grouped"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("name != dir is a located agent error (caught, never thrown)", () => {
    const tree = memTree({
      "agents/dirname/AGENT.md": agent("name: othername\ndescription: x"),
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
    const err = result?.errors.find((e) => e.kind === "agent" && e.name === "dirname");
    expect(err).toBeDefined();
    expect(err?.message).toContain('agent name "othername"');
  });

  test("a bad name is a located agent error", () => {
    const tree = memTree({
      "agents/Bad/AGENT.md": agent("name: Bad\ndescription: nope"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => e.kind === "agent" && e.name === "Bad")).toBe(true);
  });

  test("an empty description is a located agent error", () => {
    const tree = memTree({
      "agents/empty-desc/AGENT.md": agent("name: empty-desc\ndescription:"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    const err = result.errors.find((e) => e.kind === "agent" && e.name === "empty-desc");
    expect(err).toBeDefined();
    expect(err?.message).toContain("description");
  });

  test("a 600+ char agent description stays conformant (no cap)", () => {
    const tree = memTree({
      "agents/long-agent/AGENT.md": agent(`name: long-agent\ndescription: ${"x".repeat(700)}`),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validate (strict) — instruction gating", () => {
  function instruction(fm: string, body = "body"): string {
    return `---\n${fm}\n---\n${body}\n`;
  }

  test("a conformant instruction is conformant with no errors", () => {
    const tree = memTree({
      "instructions/core.instructions.md": instruction("description: core rules\napplyTo: '**'"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("an empty description is a located instruction error", () => {
    const tree = memTree({
      "instructions/empty.instructions.md": instruction("description:"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    const err = result.errors.find((e) => e.kind === "instruction" && e.name === "empty");
    expect(err).toBeDefined();
    expect(err?.message).toContain("description");
  });

  test("a missing description is a located instruction error", () => {
    const tree = memTree({
      "instructions/nodesc.instructions.md": instruction("applyTo: '**'"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => e.kind === "instruction" && e.name === "nodesc")).toBe(true);
  });

  test("an instruction with NO `---` frontmatter block degrades to a located error, never throws", () => {
    // The most likely real-world authoring error: a plain markdown body with no
    // frontmatter. parseFrontmatterRaw → undefined, safeParse(undefined) fails the
    // required `description`, one located instruction error, no throw.
    const tree = memTree({
      "instructions/raw.instructions.md": "Just plain instruction text, no frontmatter.\n",
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
    expect(result?.errors.some((e) => e.kind === "instruction" && e.name === "raw")).toBe(true);
  });

  test("unknown instruction frontmatter keys ride through (passthrough)", () => {
    const tree = memTree({
      "instructions/extra.instructions.md": instruction(
        "description: x\nderived_from: https://example.com/y\nsynced: false\nbogus: z",
      ),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validate (strict) — plugin gating", () => {
  function plugin(fm: string): string {
    return `---\n${fm}\n---\nbody\n`;
  }

  test("a conformant plugin is conformant with no errors", () => {
    const tree = memTree({
      "plugins/ok.plugin.md": plugin(
        "description: a plugin\nmarketplace_source: owner/market\nmarketplace_name: market",
      ),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a plugin missing marketplace_source is a located error naming the field, kind=plugin", () => {
    const tree = memTree({
      "plugins/bad.plugin.md": plugin("description: a plugin\nmarketplace_name: market"),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    const err = result.errors.find((e) => e.kind === "plugin" && e.name === "bad");
    expect(err).toBeDefined();
    expect(err?.message).toContain("marketplace_source");
  });

  test("a plugin with absent frontmatter degrades to a located error, never throws", () => {
    const tree = memTree({ "plugins/bare.plugin.md": "no frontmatter here\n" });
    let threw = false;
    let result: ReturnType<typeof validate> | undefined;
    try {
      result = validate(tree);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.conformant).toBe(false);
    expect(result?.errors.some((e) => e.kind === "plugin" && e.name === "bare")).toBe(true);
  });
});

describe("validate (strict) — bundle gating", () => {
  function bundle(fm: string): string {
    return `---\n${fm}\n---\nbody\n`;
  }

  test("a conformant setup-script bundle (absent installer.kind) is conformant", () => {
    const tree = memTree({
      "bundles/ok.bundle.md": bundle(
        "description: a bundle\nsource: https://x.git\npinned_commit: abc\ninstaller:\n  command: ./setup",
      ),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a setup-script bundle missing pinned_commit is a located error, kind=bundle", () => {
    const tree = memTree({
      "bundles/bad.bundle.md": bundle(
        "description: a bundle\nsource: https://x.git\ninstaller:\n  command: ./setup",
      ),
    });
    const result = validate(tree);
    expect(result.conformant).toBe(false);
    const err = result.errors.find((e) => e.kind === "bundle" && e.name === "bad");
    expect(err).toBeDefined();
    expect(err?.message).toContain("pinned_commit");
  });

  test("a bundle whose installer is absent/non-object degrades to a located error, never throws", () => {
    // The bundle-level superRefine reads bundle.installer.kind — safe only because
    // Zod skips refinements when the object parse already failed. This pins that
    // never-throw contract through the full validate() path (a refactor that
    // reordered the refinement could otherwise throw on a missing installer).
    const tree = memTree({
      "bundles/no-installer.bundle.md": bundle("description: a bundle\nsource: https://x.git\npinned_commit: abc"),
      "bundles/string-installer.bundle.md": bundle("description: a bundle\ninstaller: just-a-string"),
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
    expect(result?.errors.some((e) => e.kind === "bundle" && e.name === "no-installer")).toBe(true);
    expect(result?.errors.some((e) => e.kind === "bundle" && e.name === "string-installer")).toBe(true);
  });

  test("a bundle with unparseable frontmatter degrades to a located error, never throws", () => {
    // A malformed YAML block (bad indentation under a mapping) makes yamlParse throw.
    const tree = memTree({
      "bundles/broken.bundle.md": "---\ndescription: x\n  : : bad\n\t- tab\n---\nbody\n",
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
    expect(result?.errors.some((e) => e.kind === "bundle" && e.name === "broken")).toBe(true);
  });
});

// The load-bearing regression guard (acceptance criterion 1): the stricter gate
// still accepts the EXACT real reference frontmatters. This — not deploy.test.ts,
// which never calls validate() — is what proves real content stays conformant.
describe("validate (strict) — real my-agent-kits reference content stays conformant", () => {
  test("3 plugins + gstack (setup-script, no installer.kind) + hyperframes (npx-skills) → conformant", () => {
    const tree = memTree({
      "plugins/frontend-design.plugin.md": [
        "---",
        "description: Distinctive, production-grade frontend interfaces — web components, landing pages, dashboards, React/HTML/CSS layouts.",
        'applyTo: "**"',
        "added_in: 0.10.2",
        "marketplace_source: anthropics/claude-plugins-official",
        "marketplace_name: claude-plugins-official",
        "plugin_name: frontend-design",
        "---",
        "# Frontend Design",
      ].join("\n"),
      "plugins/superpowers.plugin.md": [
        "---",
        "description: Agentic skills (TDD, debugging, brainstorming, planning, code review)",
        'applyTo: "**"',
        "added_in: 0.2.0",
        "marketplace_source: anthropics/claude-plugins-official",
        "marketplace_name: claude-plugins-official",
        "plugin_name: superpowers",
        "---",
        "# Superpowers",
      ].join("\n"),
      "plugins/ui-ux-pro-max.plugin.md": [
        "---",
        "description: Design intelligence skill — 50+ UI styles, 97 color palettes, 57 font pairings, 99 UX guidelines, 25 chart types across 9 stacks.",
        'applyTo: "**"',
        "added_in: 0.10.2",
        "marketplace_source: nextlevelbuilder/ui-ux-pro-max-skill",
        "marketplace_name: ui-ux-pro-max-skill",
        "plugin_name: ui-ux-pro-max",
        "---",
        "# UI UX Pro Max",
      ].join("\n"),
      "bundles/gstack.bundle.md": [
        "---",
        "description: gstack — 30+ slash commands. Installs to ~/.claude/skills/gstack/ with /gstack-* prefix.",
        "added_in: 0.7.0",
        "source: https://github.com/garrytan/gstack.git",
        "pinned_commit: dc6252d1df7f1f650ea6e9b2bba7d08fab5de902",
        "scope: global",
        "installer:",
        "  command: ./setup",
        '  flags: ["--prefix", "--no-team", "--quiet"]',
        "  host_flag_map:",
        '    claude: ["--host", "claude"]',
        '    codex: ["--host", "codex"]',
        "requires:",
        "  - bun",
        "  - git",
        "verify_paths:",
        '  claude: "~/.claude/skills/gstack"',
        '  codex: "~/.agents/skills/gstack"',
        "license: MIT",
        "---",
        "# gstack bundle",
      ].join("\n"),
      "bundles/hyperframes.bundle.md": [
        "---",
        "description: hyperframes — HTML-native video rendering for AI agents.",
        "added_in: 0.8.0",
        "scope: global",
        "installer:",
        "  kind: npx-skills",
        "  package: heygen-com/hyperframes",
        "requires:",
        "  - node",
        "  - npx",
        "  - ffmpeg",
        "verify_paths:",
        '  claude: "~/.claude/skills/hyperframes"',
        '  codex: "~/.agents/skills/hyperframes"',
        "license: Apache-2.0",
        "---",
        "# hyperframes bundle",
      ].join("\n"),
    });
    const result = validate(tree);
    expect(result.errors).toEqual([]);
    expect(result.conformant).toBe(true);
  });
});

// Exhaustive reference-content regression guard (acceptance criterion 4): run the
// new agent + instruction schemas against EVERY `AGENT.md` and `*.instructions.md`
// at the pinned my-agent-kits production revision (not a hand-picked few). If ANY real
// frontmatter is rejected, the lenient-superset claim is false — the test fails
// loudly naming the offender, so the schema (not the content) is revisited.
describe("validate (strict) — ALL real my-agent-kits agent + instruction content stays conformant", () => {
  const CLONE = fileURLToPath(
    new URL("../../../scripts/fixtures/my-agent-kits", import.meta.url),
  );
  const CAPS = join(CLONE, "capabilities");

  // Recursive walk — agents legitimately nest under @-groups, so AGENT.md markers
  // live at any depth (enumerateLeaves flattens @-group ancestors to the leaf).
  function walkFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walkFiles(full));
      else out.push(full);
    }
    return out;
  }

  // Top-level-only list — instruction is a FILE kind; enumerateLeaves'
  // collectFileKind enumerates only the top level of `instructions/`, never
  // recursing. Mirror that here so the guard tests exactly the set validate()
  // walks (a nested `instructions/sub/x.instructions.md` is not a leaf, so feeding
  // it to the memTree would silently under-test).
  function listTopLevel(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((entry) => join(dir, entry))
      .filter((full) => !statSync(full).isDirectory());
  }

  // Keys are paths relative to `capabilities/` (what memTree/enumerateLeaves walk).
  function cloneTree(): Record<string, string> {
    const files: Record<string, string> = {};
    const agentMd = walkFiles(join(CAPS, "agents")).filter((f) => f.endsWith("AGENT.md"));
    const instrMd = listTopLevel(join(CAPS, "instructions")).filter((f) =>
      f.endsWith(".instructions.md"),
    );
    for (const f of [...agentMd, ...instrMd]) {
      const rel = relative(CAPS, f).replace(/\\/g, "/");
      files[rel] = readFileSync(f, "utf8");
    }
    return files;
  }

  test("every pinned AGENT.md and *.instructions.md validates conformant:true", () => {
    const files = cloneTree();
    // Guard against an incomplete fixture so this cannot pass without exercising
    // both supported capability kinds.
    const agentCount = Object.keys(files).filter((k) => k.startsWith("agents/")).length;
    const instrCount = Object.keys(files).filter((k) => k.startsWith("instructions/")).length;
    if (agentCount === 0 || instrCount === 0) {
      throw new Error(
        "pinned my-agent-kits fixture is incomplete; see scripts/fixtures/my-agent-kits/PIN.json",
      );
    }
    const result = validate(memTree(files));
    expect(result.errors).toEqual([]);
    expect(result.conformant).toBe(true);
  });
});
