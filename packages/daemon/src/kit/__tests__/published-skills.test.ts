import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { DEFAULT_TREE_LIMITS } from "../acquisition/tree-guard.ts";
import type { SyncError } from "../effect/errors.ts";
import { planIngest } from "../mirror.ts";
import { type Recognition, recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { type MemoryFile, memorySnapshot } from "./helpers.ts";

// Expected skills below follow skills@1.7.2 discoverSkills, worked by hand from
// its source, not from this port's output.

const skill = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\nbody\n`;
const internal = (name: string) => skill(name, "metadata:\n  internal: true\n");
const PLUGIN_ROOT_LINE = `python3 "\${CLAUDE_PLUGIN_ROOT}/scripts/search.py"\n`;

async function recognize(
  files: Record<string, MemoryFile>,
): Promise<Exit.Exit<Recognition, SyncError>> {
  return Effect.runPromiseExit(
    recognizeSource(recipeTree(memorySnapshot(files).snapshot, DEFAULT_TREE_LIMITS)),
  );
}

async function recognized(files: Record<string, MemoryFile>): Promise<Recognition> {
  const exit = await recognize(files);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

async function publishedCopies(files: Record<string, MemoryFile>): Promise<string[]> {
  const recognition = await recognized(files);
  expect(recognition.recipe).toEqual({
    id: "published-skills",
    label: "Published skills",
    unit: "pick",
  });
  return recognition.projection.copies.map((copy) => {
    expect(copy.exclude).toBe("skills-cli");
    return `${copy.from} -> ${copy.to}`;
  });
}

describe("published-skills discovery", () => {
  test("archify: the one skill folder, not the internal skills under .agents/skills", async () => {
    expect(
      await publishedCopies({
        "archify/SKILL.md": skill("archify"),
        "archify/references/diagrams.md": "reference",
        ".agents/skills/release/SKILL.md": internal("release"),
        ".agents/skills/docs-sync/SKILL.md": internal("docs-sync"),
        ".agents/skills/triage/SKILL.md": internal("triage"),
        ".agents/skills/bump/SKILL.md": internal("bump"),
        "README.md": "archify",
      }),
    ).toEqual(["archify -> capabilities/skills/archify"]);
  });

  test("slidev: skills/slidev wins over a Claude-only marketplace whose plugin is the root", async () => {
    expect(
      await publishedCopies({
        "skills/slidev/SKILL.md": skill("slidev"),
        "skills/slidev/references/syntax.md": "syntax",
        ".claude-plugin/marketplace.json": JSON.stringify({
          name: "slidev-plugins",
          owner: { name: "slidev" },
          plugins: [{ name: "slidev", source: "./" }],
        }),
        "packages/slidev/package.json": "{}",
      }),
    ).toEqual(["skills/slidev -> capabilities/skills/slidev"]);
  });

  test("hyperframes: the 7 skills under skills/, none of the internal agent-dir copies", async () => {
    const files: Record<string, MemoryFile> = {};
    for (const name of [
      "hyperframes",
      "hyperframes-cli",
      "hyperframes-registry",
      "media-use",
      "figma",
      "slideshow",
      "remotion-to-hyperframes",
    ]) {
      files[`skills/${name}/SKILL.md`] = skill(name);
    }
    for (const name of [
      "release",
      "changelog",
      "docs-writer",
      "pr-review",
      "test-runner",
      "triage",
    ]) {
      files[`.claude/skills/${name}/SKILL.md`] = internal(name);
      files[`.agents/skills/${name}/SKILL.md`] = internal(name);
    }
    expect(await publishedCopies(files)).toEqual([
      "skills/figma -> capabilities/skills/figma",
      "skills/hyperframes -> capabilities/skills/hyperframes",
      "skills/hyperframes-cli -> capabilities/skills/hyperframes-cli",
      "skills/hyperframes-registry -> capabilities/skills/hyperframes-registry",
      "skills/media-use -> capabilities/skills/media-use",
      "skills/remotion-to-hyperframes -> capabilities/skills/remotion-to-hyperframes",
      "skills/slideshow -> capabilities/skills/slideshow",
    ]);
  });

  test("gstack: a root SKILL.md is the only skill, copied from the root", async () => {
    expect(
      await publishedCopies({
        "SKILL.md": skill("gstack"),
        "browse/SKILL.md": skill("browse"),
        "qa/SKILL.md": skill("qa"),
        ".agents/skills/gstack-ship/SKILL.md": skill("gstack-ship"),
        setup: { exec: "#!/usr/bin/env bash\n" },
      }),
    ).toEqual([" -> capabilities/skills/gstack"]);
  });

  test("ui-ux-pro-max: a skill whose folder names the plugin root anywhere is left out", async () => {
    const tree: Record<string, MemoryFile> = {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "ui-ux-pro-max",
        skills: ["./.claude/skills/ui-ux-pro-max", "./.claude/skills/design-system"],
      }),
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "ui-ux-pro-max-skill",
        plugins: [{ name: "ui-ux-pro-max", source: "./" }],
      }),
      ".claude/skills/ui-ux-pro-max/SKILL.md": skill("ui-ux-pro-max"),
      ".claude/skills/ui-ux-pro-max/scripts/run.sh": { exec: PLUGIN_ROOT_LINE },
      ".claude/skills/design-system/SKILL.md": skill("design-system"),
      "cli/package.json": "{}",
    };
    expect(await publishedCopies(tree)).toEqual([
      ".claude/skills/design-system -> capabilities/skills/design-system",
    ]);

    const runtimeOnly = { ...tree };
    delete runtimeOnly[".claude/skills/design-system/SKILL.md"];
    expect((await recognized(runtimeOnly)).recipe.id).toBe("single-cli-marketplace");

    delete runtimeOnly[".claude-plugin/marketplace.json"];
    const exit = await recognize(runtimeOnly);
    if (Exit.isSuccess(exit)) throw new Error("expected not_recognized");
    expect((Cause.squash(exit.cause) as SyncError).detail).toContain(
      "1 published skill needs a plugin runtime",
    );
  });

  test("a Claude-only marketplace whose plugins hold skills publishes those skills", async () => {
    expect(
      await publishedCopies({
        ".claude-plugin/marketplace.json": JSON.stringify({
          name: "m",
          plugins: [{ name: "ye", source: "./plugins/ye" }],
        }),
        "plugins/ye/skills/beta/SKILL.md": skill("beta"),
        "plugins/ye/skills/alpha/SKILL.md": skill("alpha"),
      }),
    ).toEqual([
      "plugins/ye/skills/alpha -> capabilities/skills/alpha",
      "plugins/ye/skills/beta -> capabilities/skills/beta",
    ]);
  });

  test("yestack: both marketplace files still make a plugin marketplace", async () => {
    const recognition = await recognized({
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "yestack",
        plugins: [{ name: "ye", source: "./plugins/ye" }],
      }),
      ".agents/plugins/marketplace.json": JSON.stringify({
        name: "yestack",
        plugins: [{ name: "ye", source: { source: "local", path: "./plugins/ye" } }],
      }),
      "plugins/ye/skills/ye-flow/SKILL.md": skill("ye-flow"),
      "plugins/ye/skills/how/SKILL.md": skill("how"),
    });
    expect(recognition.recipe.id).toBe("plugin-marketplace");
    expect(recognition.projection.copies).toEqual([]);
  });

  test("skills-lock.json leaves out installed project skills by normalized skill or folder name", async () => {
    const entry = { source: "acme/skills", sourceType: "github" };
    expect(
      await publishedCopies({
        "skills-lock.json": JSON.stringify({
          version: 1,
          skills: { locked_one: entry, Dir_Locked: entry, "also-locked": entry },
        }),
        ".claude/skills/one/SKILL.md": skill("Locked One"),
        ".agents/skills/dir-locked/SKILL.md": skill("renamed"),
        ".agents/skills/fresh/SKILL.md": skill("fresh"),
        "skills/also-locked/SKILL.md": skill("also-locked"),
      }),
    ).toEqual([
      "skills/also-locked -> capabilities/skills/also-locked",
      ".agents/skills/fresh -> capabilities/skills/fresh",
    ]);
  });

  test("a SKILL.md needs a non-empty string name and description, and stops the walk either way", async () => {
    expect(
      await publishedCopies({
        "skills/ok/SKILL.md": skill("ok"),
        "skills/empty-name/SKILL.md": '---\nname: ""\ndescription: d\n---\n',
        "skills/empty-description/SKILL.md": '---\nname: empty-description\ndescription: ""\n---\n',
        "skills/number-name/SKILL.md": "---\nname: 42\ndescription: d\n---\n",
        "skills/broken/SKILL.md": "no frontmatter",
        "skills/broken/inner/SKILL.md": skill("inner"),
      }),
    ).toEqual(["skills/ok -> capabilities/skills/ok"]);
  });

  test("the first skill in the CLI's search order keeps a name; later ones are left out", async () => {
    expect(
      await publishedCopies({
        "zz-first/SKILL.md": skill("dup"),
        "skills/aa/SKILL.md": skill("dup"),
        ".claude/skills/dup/SKILL.md": skill("dup"),
      }),
    ).toEqual(["zz-first -> capabilities/skills/dup"]);
  });

  test("a skill installs under the CLI's sanitized folder name, or is left out", async () => {
    expect(
      await publishedCopies({
        "skills/a/SKILL.md": skill("My Skill"),
        "skills/b/SKILL.md": skill("dotted.name"),
        "skills/c/SKILL.md": skill("my skill"),
      }),
    ).toEqual(["skills/a -> capabilities/skills/my-skill"]);
  });

  test("SKIP_DIRS stop descent in the search and the fallback, not a match by name", async () => {
    expect(
      await publishedCopies({
        "dist/SKILL.md": skill("dist-skill"),
        "skills/real/SKILL.md": skill("real"),
        "skills/node_modules/x/SKILL.md": skill("x"),
      }),
    ).toEqual([
      "dist -> capabilities/skills/dist-skill",
      "skills/real -> capabilities/skills/real",
    ]);
    expect(
      await publishedCopies({
        "docs/a/b/SKILL.md": skill("deep"),
        "node_modules/pkg/SKILL.md": skill("pkg"),
        "build/tool/SKILL.md": skill("tool"),
        "src/dist/x/SKILL.md": skill("x"),
      }),
    ).toEqual(["docs/a/b -> capabilities/skills/deep"]);
  });

  test("the fallback search reaches folders five levels down, not six", async () => {
    expect(
      await publishedCopies({
        "l1/l2/l3/l4/l5/SKILL.md": skill("five"),
        "m1/m2/m3/m4/m5/m6/SKILL.md": skill("six"),
      }),
    ).toEqual(["l1/l2/l3/l4/l5 -> capabilities/skills/five"]);
  });

  test("a skill copy leaves out what the CLI's copyDirectory leaves out, except inside a linked folder", async () => {
    const { snapshot } = memorySnapshot({
      "skills/tool/SKILL.md": skill("tool"),
      "skills/tool/notes.md": "kept",
      "skills/tool/metadata.json": "{}",
      "skills/tool/sub/metadata.json": "{}",
      "skills/tool/__pycache__/m.pyc": "cache",
      "skills/tool/__pypackages__/p/x.py": "vendored",
      "skills/tool/.git/config": "git",
      "skills/tool/shared": { link: "../../shared" },
      "shared/metadata.json": "{}",
      "shared/__pycache__/c.pyc": "cache",
    });
    const plan = await Effect.runPromise(
      recognizeSource(recipeTree(snapshot, DEFAULT_TREE_LIMITS)).pipe(
        Effect.flatMap((recognition) =>
          planIngest(snapshot.entries, recognition.projection, DEFAULT_TREE_LIMITS),
        ),
      ),
    );
    expect(plan.entries.map((entry) => entry.to)).toEqual([
      "capabilities/skills/tool/SKILL.md",
      "capabilities/skills/tool/notes.md",
      "capabilities/skills/tool/shared/__pycache__/c.pyc",
      "capabilities/skills/tool/shared/metadata.json",
    ]);
  });

  test("a linked agent skills folder is searched like a real one and copied through the link", async () => {
    const { snapshot } = memorySnapshot({
      ".claude/skills": { link: "../shared-skills" },
      "shared-skills/linked/SKILL.md": skill("linked"),
      "shared-skills/linked/run.sh": { exec: "#!/bin/sh\n" },
    });
    const recognition = await Effect.runPromise(
      recognizeSource(recipeTree(snapshot, DEFAULT_TREE_LIMITS)),
    );
    expect(recognition.projection.copies.map((copy) => `${copy.from} -> ${copy.to}`)).toEqual([
      ".claude/skills/linked -> capabilities/skills/linked",
    ]);
    const plan = await Effect.runPromise(
      planIngest(snapshot.entries, recognition.projection, DEFAULT_TREE_LIMITS),
    );
    expect(plan.entries.map((entry) => `${entry.to} ${entry.mode.toString(8)}`)).toEqual([
      "capabilities/skills/linked/SKILL.md 644",
      "capabilities/skills/linked/run.sh 755",
    ]);
  });
});
