import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployTarget } from "@hive/contract";
import type { DeployTargets } from "../targets.ts";
import * as npxBundle from "./npx-bundle.ts";
import { bundleMeta } from "./sources.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mirrorWithBundle(frontmatter: string): string {
  const root = mkdtempSync(join(tmpdir(), "managed-npx-bundle-"));
  roots.push(root);
  const directory = join(root, "capabilities", "bundles");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "archify.bundle.md"), `---\n${frontmatter}\n---\narchify\n`);
  return root;
}

describe("managed npx bundle metadata", () => {
  test("normalizes exact skills and scalar-or-list verification paths", () => {
    const mirror = mirrorWithBundle(`description: archify
installer:
  kind: npx-skills
  package: tt-a1i/archify@2.10.0
  skills: [archify, archify-export]
verify_paths:
  claude: ~/.claude/skills/archify
  codex:
    - ~/.agents/skills/archify
    - ~/.agents/skills/archify-export`);

    expect(bundleMeta(mirror, "archify")).toMatchObject({
      installerKind: "npx-skills",
      pkg: "tt-a1i/archify@2.10.0",
      skills: ["archify", "archify-export"],
      verifyPaths: {
        claude: ["~/.claude/skills/archify"],
        codex: ["~/.agents/skills/archify", "~/.agents/skills/archify-export"],
      },
    });
  });

  test("keeps incomplete declarations explicit instead of inferring ownership", () => {
    const mirror = mirrorWithBundle(`description: legacy
installer:
  kind: npx-skills
  package: owner/pkg`);

    expect(bundleMeta(mirror, "archify")).toMatchObject({
      skills: [],
      verifyPaths: {},
    });
  });

  test("accepts only pinned complete metadata and resolves target-owned paths", () => {
    const mirror = mirrorWithBundle(`description: archify
installer:
  kind: npx-skills
  package: https://github.com/tt-a1i/archify/tree/${"a".repeat(40)}
  skills: [archify]
verify_paths:
  claude: ~/.claude/skills/archify
  codex: ~/.agents/skills/archify`);
    const parsed = bundleMeta(mirror, "archify");
    if (!parsed) throw new Error("bundle fixture did not parse");
    const root = mkdtempSync(join(tmpdir(), "managed-npx-homes-"));
    roots.push(root);
    const targets = {
      claudeHome: () => join(root, ".claude"),
      agentsHome: () => join(root, ".agents"),
    } as Pick<DeployTargets, "claudeHome" | "agentsHome">;
    const managed = Reflect.get(npxBundle, "managedNpxBundleMeta") as
      | ((
          meta: typeof parsed,
          target: DeployTarget,
          homes: Pick<DeployTargets, "claudeHome" | "agentsHome">,
        ) => { package: string; skills: string[]; verifyPaths: string[] } | null)
      | undefined;

    expect(managed).toBeFunction();
    if (!managed) throw new Error("managedNpxBundleMeta is unavailable");
    expect(managed(parsed, "claude", targets)).toEqual({
      package: `https://github.com/tt-a1i/archify/tree/${"a".repeat(40)}`,
      skills: ["archify"],
      verifyPaths: [join(root, ".claude", "skills", "archify")],
    });
    expect(managed(parsed, "codex", targets)).toEqual({
      package: `https://github.com/tt-a1i/archify/tree/${"a".repeat(40)}`,
      skills: ["archify"],
      verifyPaths: [join(root, ".agents", "skills", "archify")],
    });
  });

  test("rejects mutable, incomplete, and target-escaping declarations", () => {
    const root = mkdtempSync(join(tmpdir(), "managed-npx-reject-"));
    roots.push(root);
    const targets = {
      claudeHome: () => join(root, ".claude"),
      agentsHome: () => join(root, ".agents"),
    } as Pick<DeployTargets, "claudeHome" | "agentsHome">;
    const managed = Reflect.get(npxBundle, "managedNpxBundleMeta") as
      | ((
          meta: NonNullable<ReturnType<typeof bundleMeta>>,
          target: DeployTarget,
          homes: Pick<DeployTargets, "claudeHome" | "agentsHome">,
        ) => unknown)
      | undefined;
    expect(managed).toBeFunction();
    if (!managed) throw new Error("managedNpxBundleMeta is unavailable");

    for (const frontmatter of [
      `description: mutable\ninstaller:\n  kind: npx-skills\n  package: owner/repo\n  skills: [archify]\nverify_paths:\n  claude: ~/.claude/skills/archify`,
      `description: missing skills\ninstaller:\n  kind: npx-skills\n  package: https://github.com/o/r/tree/${"b".repeat(40)}\nverify_paths:\n  claude: ~/.claude/skills/archify`,
      `description: escape\ninstaller:\n  kind: npx-skills\n  package: https://github.com/o/r/tree/${"c".repeat(40)}\n  skills: [archify]\nverify_paths:\n  claude: ~/.claude/skills/../secrets`,
    ]) {
      const mirror = mirrorWithBundle(frontmatter);
      const parsed = bundleMeta(mirror, "archify");
      if (!parsed) throw new Error("bundle fixture did not parse");
      expect(managed(parsed, "claude", targets)).toBeNull();
    }
  });

  test("hashes normalized metadata stably and includes the deploy target", () => {
    const hash = Reflect.get(npxBundle, "managedNpxBundleHash") as
      | ((
          meta: { package: string; skills: string[]; verifyPaths: string[] },
          target: DeployTarget,
        ) => string)
      | undefined;
    expect(hash).toBeFunction();
    if (!hash) throw new Error("managedNpxBundleHash is unavailable");
    const meta = {
      package: `https://github.com/tt-a1i/archify/tree/${"d".repeat(40)}`,
      skills: ["archify"],
      verifyPaths: ["/tmp/homes/.claude/skills/archify"],
    };

    expect(hash(meta, "claude")).toBe(hash({ ...meta, skills: [...meta.skills] }, "claude"));
    expect(hash(meta, "claude")).toMatch(/^[0-9a-f]{64}$/);
    expect(hash(meta, "codex")).not.toBe(hash(meta, "claude"));
  });

  test("probes all-present, all-absent, and mixed verification paths", () => {
    const probe = Reflect.get(npxBundle, "probeManagedNpxBundle") as
      | ((meta: { package: string; skills: string[]; verifyPaths: string[] }) => string)
      | undefined;
    expect(probe).toBeFunction();
    if (!probe) throw new Error("probeManagedNpxBundle is unavailable");
    const root = mkdtempSync(join(tmpdir(), "managed-npx-probe-"));
    roots.push(root);
    const first = join(root, "archify");
    const second = join(root, "archify-export");
    const meta = { package: "pinned", skills: ["archify"], verifyPaths: [first, second] };

    expect(probe(meta)).toBe("all-absent");
    mkdirSync(first, { recursive: true });
    expect(probe(meta)).toBe("mixed");
    mkdirSync(second, { recursive: true });
    expect(probe(meta)).toBe("all-present");
  });
});
