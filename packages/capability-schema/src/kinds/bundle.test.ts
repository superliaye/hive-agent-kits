import { describe, expect, test } from "bun:test";
import { BundleFrontmatter } from "../index.ts";

// Minimal setup-script: top-level source + pinned_commit, installer.command, and an
// ABSENT installer.kind (the default that every existing fixture relies on).
const MINIMAL_SETUP_SCRIPT = {
  description: "a setup-script bundle",
  source: "https://example.com/x.git",
  pinned_commit: "abc123",
  installer: { command: "./setup" },
};

const MINIMAL_NPX = {
  description: "an npx-skills bundle",
  installer: { kind: "npx-skills", package: "owner/pkg" },
};

describe("BundleFrontmatter — valid fixtures (lenient superset)", () => {
  test("minimal setup-script (absent installer.kind defaults) passes", () => {
    expect(BundleFrontmatter.safeParse(MINIMAL_SETUP_SCRIPT).success).toBe(true);
  });

  test("minimal npx-skills passes", () => {
    expect(BundleFrontmatter.safeParse(MINIMAL_NPX).success).toBe(true);
  });

  test("explicit installer.kind: setup-script passes", () => {
    const fm = { ...MINIMAL_SETUP_SCRIPT, installer: { kind: "setup-script", command: "./setup" } };
    expect(BundleFrontmatter.safeParse(fm).success).toBe(true);
  });

  // reference: gstack.bundle.md — setup-script, ABSENT installer.kind, full optional
  // load (flags, host_flag_map, requires, verify_paths, scope, license).
  test("reference: gstack.bundle.md (setup-script, no installer.kind)", () => {
    const fm = {
      description:
        "gstack — 30+ slash commands. Installs to ~/.claude/skills/gstack/ with /gstack-* prefix.",
      added_in: "0.7.0",
      source: "https://github.com/garrytan/gstack.git",
      pinned_commit: "dc6252d1df7f1f650ea6e9b2bba7d08fab5de902",
      scope: "global",
      installer: {
        command: "./setup",
        flags: ["--prefix", "--no-team", "--quiet"],
        host_flag_map: {
          claude: ["--host", "claude"],
          codex: ["--host", "codex"],
        },
      },
      requires: ["bun", "git"],
      verify_paths: {
        claude: "~/.claude/skills/gstack",
        codex: "~/.agents/skills/gstack",
      },
      license: "MIT",
    };
    expect(BundleFrontmatter.safeParse(fm).success).toBe(true);
  });

  // reference: hyperframes.bundle.md — npx-skills, NO top-level source/pinned_commit.
  test("reference: hyperframes.bundle.md (npx-skills, no source/pinned_commit)", () => {
    const fm = {
      description: "hyperframes — HTML-native video rendering for AI agents.",
      added_in: "0.8.0",
      scope: "global",
      installer: { kind: "npx-skills", package: "heygen-com/hyperframes" },
      requires: ["node", "npx", "ffmpeg"],
      verify_paths: {
        claude: "~/.claude/skills/hyperframes",
        codex: "~/.agents/skills/hyperframes",
      },
      license: "Apache-2.0",
    };
    expect(BundleFrontmatter.safeParse(fm).success).toBe(true);
  });

  // CROSS-LEVEL ASYMMETRY (positive guard): an npx-skills bundle that OMITS top-level
  // source + pinned_commit stays conformant — those fields are required only on the
  // setup-script arm, enforced by the bundle-level superRefine, not the union. Guards
  // against a future over-tightening that requires them unconditionally.
  test("npx-skills WITHOUT source/pinned_commit is conformant (asymmetry holds)", () => {
    const result = BundleFrontmatter.safeParse(MINIMAL_NPX);
    expect(result.success).toBe(true);
  });

  test("unknown keys ride through passthrough on both arms", () => {
    expect(BundleFrontmatter.safeParse({ ...MINIMAL_SETUP_SCRIPT, upstream: "x" }).success).toBe(true);
    expect(BundleFrontmatter.safeParse({ ...MINIMAL_NPX, upstream: "x" }).success).toBe(true);
  });

  test("installer-level unknown keys ride through passthrough", () => {
    const fm = { ...MINIMAL_SETUP_SCRIPT, installer: { command: "./setup", env: { FOO: "bar" } } };
    expect(BundleFrontmatter.safeParse(fm).success).toBe(true);
  });

  test("managed npx-skills metadata accepts exact skills and scalar-or-list verify paths", () => {
    const fm = {
      ...MINIMAL_NPX,
      installer: {
        kind: "npx-skills",
        package: "owner/pkg@v1.2.3",
        skills: ["archify", "archify-export"],
      },
      verify_paths: {
        claude: "~/.claude/skills/archify",
        codex: ["~/.codex/skills/archify", "~/.codex/skills/archify-export"],
      },
    };
    expect(BundleFrontmatter.safeParse(fm).success).toBe(true);
  });
});

describe("BundleFrontmatter — one invalid case per rule", () => {
  function reject(obj: unknown): { msg: string } | null {
    const result = BundleFrontmatter.safeParse(obj);
    if (result.success) return null;
    return { msg: result.error.issues.map((i) => `${i.message} ${i.path.join(".")}`).join(" | ") };
  }

  test("missing description", () => {
    const { description: _drop, ...rest } = MINIMAL_SETUP_SCRIPT;
    const r = reject(rest);
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("description");
  });

  test("setup-script missing top-level source — names the field", () => {
    const { source: _drop, ...rest } = MINIMAL_SETUP_SCRIPT;
    const r = reject(rest);
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("source");
  });

  test("setup-script missing top-level pinned_commit — names the field", () => {
    const { pinned_commit: _drop, ...rest } = MINIMAL_SETUP_SCRIPT;
    const r = reject(rest);
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("pinned_commit");
  });

  test("setup-script blank source/pinned_commit rejected (non-empty enforced)", () => {
    expect(reject({ ...MINIMAL_SETUP_SCRIPT, source: "" })).not.toBeNull();
    expect(reject({ ...MINIMAL_SETUP_SCRIPT, pinned_commit: "" })).not.toBeNull();
  });

  test("setup-script missing installer.command", () => {
    const fm = { ...MINIMAL_SETUP_SCRIPT, installer: {} };
    const r = reject(fm);
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("command");
  });

  test("npx-skills missing installer.package — names the field", () => {
    const fm = { ...MINIMAL_NPX, installer: { kind: "npx-skills" } };
    const r = reject(fm);
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("package");
  });

  test("npx-skills blank installer.package", () => {
    const fm = { ...MINIMAL_NPX, installer: { kind: "npx-skills", package: "" } };
    expect(reject(fm)).not.toBeNull();
  });

  test("npx-skills rejects blank or duplicate managed skill names", () => {
    expect(
      reject({
        ...MINIMAL_NPX,
        installer: { kind: "npx-skills", package: "owner/pkg", skills: [""] },
      }),
    ).not.toBeNull();
    expect(
      reject({
        ...MINIMAL_NPX,
        installer: { kind: "npx-skills", package: "owner/pkg", skills: ["archify", "archify"] },
      }),
    ).not.toBeNull();
  });

  test("verify_paths rejects empty target paths and unsupported targets", () => {
    expect(reject({ ...MINIMAL_NPX, verify_paths: { claude: [] } })).not.toBeNull();
    expect(reject({ ...MINIMAL_NPX, verify_paths: { codex: "" } })).not.toBeNull();
    expect(
      reject({ ...MINIMAL_NPX, verify_paths: { cursor: "~/.cursor/skills/archify" } }),
    ).not.toBeNull();
  });

  test("unknown installer.kind is rejected (discriminated union)", () => {
    const fm = { ...MINIMAL_NPX, installer: { kind: "wat", package: "x" } };
    expect(reject(fm)).not.toBeNull();
  });

  // Pin the preprocess contract: a PRESENT blank `kind: ""` is NOT defaulted to
  // setup-script — it falls through to the union as an invalid discriminator. Guards
  // against a future `if (!obj.kind)` that would wrongly coerce a blank string.
  test("blank installer.kind ('') is rejected, not defaulted to setup-script", () => {
    const fm = { ...MINIMAL_SETUP_SCRIPT, installer: { kind: "", command: "./setup" } };
    const r = reject(fm);
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("installer");
  });

  // Pin the non-object installer path: array / string / null surface as a clean
  // located error at `installer`, never a throw and never a misleading missing-field.
  test("a non-object installer (array/string/null) is rejected cleanly", () => {
    expect(reject({ ...MINIMAL_SETUP_SCRIPT, installer: ["x"] })).not.toBeNull();
    expect(reject({ ...MINIMAL_SETUP_SCRIPT, installer: "setup" })).not.toBeNull();
    expect(reject({ ...MINIMAL_SETUP_SCRIPT, installer: null })).not.toBeNull();
    const arr = reject({ ...MINIMAL_SETUP_SCRIPT, installer: ["x"] });
    expect(arr?.msg).toContain("installer");
  });

  test("a missing installer block is rejected (installer is required)", () => {
    const { installer: _drop, ...rest } = MINIMAL_SETUP_SCRIPT;
    const r = reject(rest);
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("installer");
  });
});
