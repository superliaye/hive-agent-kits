import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import type { DeployFsExec, ExecPort, ExecRequest } from "../deploy/adapter.ts";
import { runDeploy } from "../deploy/engine.ts";
import { DeployError } from "../effect/errors.ts";
import { readLedger } from "../ledger.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";
import type { ResolvedSelection } from "../types.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;
let targets: DeployTargets;
let mirror: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
  targets = defaultDeployTargets();
  mirror = targets.mirrorRoot();
  mkdirSync(mirror, { recursive: true });
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- mirror fixture builders ----

function seedSkill(
  name: string,
  opts: { disableModelInvocation?: boolean; extraFiles?: Record<string, string> } = {},
): void {
  const dir = join(mirror, "capabilities", "skills", name);
  mkdirSync(dir, { recursive: true });
  const fm = opts.disableModelInvocation
    ? "description: s\ndisable-model-invocation: true"
    : "description: s";
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\nskill body ${name}\n`);
  // maintainer-only assets that must be filtered out.
  writeFileSync(join(dir, "SOURCE.md"), "maintainer\n");
  mkdirSync(join(dir, "_unshipped"), { recursive: true });
  writeFileSync(join(dir, "_unshipped", "draft.md"), "draft\n");
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function seedInstruction(name: string, body: string): void {
  const dir = join(mirror, "capabilities", "instructions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.instructions.md`), `---\ndescription: ${name}\n---\n${body}\n`);
}

function seedPlugin(name: string): void {
  const dir = join(mirror, "capabilities", "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.plugin.md`),
    `---\ndescription: p\nmarketplace_source: owner/market\nmarketplace_name: market\nplugin_name: ${name}\n---\nplugin\n`,
  );
}

function seedBundle(name: string): void {
  const dir = join(mirror, "capabilities", "bundles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.bundle.md`),
    `---\ndescription: b\nsource: https://example.com/${name}.git\npinned_commit: abc123\ninstaller:\n  command: ./setup\n  flags: ["--quiet"]\n  host_flag_map:\n    claude: ["--host", "claude"]\n    codex: ["--host", "codex"]\n---\nbundle\n`,
  );
}

function resolved(over: Partial<ResolvedSelection>): ResolvedSelection {
  return {
    instructions: [],
    skills: [],
    agents: [],
    plugins: [],
    bundles: [],
    targets: ["claude"],
    ...over,
  };
}

// A spy exec port recording every call.
function makeSpy(statusFor: (req: ExecRequest) => number = () => 0): {
  port: ExecPort;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  const port: ExecPort = (req) => {
    calls.push(req);
    return { status: statusFor(req), stdout: "", stderr: "" };
  };
  return { port, calls };
}

function fx(exec: ExecPort, probe: (n: string) => boolean = () => true): DeployFsExec {
  return { targets, exec, probe: (n) => probe(n) };
}

describe("runDeploy", () => {
  test("(a) skill lands in both homes; no SOURCE.md / _unshipped", async () => {
    seedSkill("alpha");
    const spy = makeSpy();
    const result = await Effect.runPromise(
      runDeploy(fx(spy.port), {
        selection: resolved({ skills: ["alpha"], targets: ["claude", "codex"] }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );

    expect(result.perKind.find((k) => k.kind === "skill")?.applied).toEqual(["alpha"]);
    expect(existsSync(join(targets.claudeHome(), "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(targets.agentsHome(), "skills", "alpha", "SKILL.md"))).toBe(true);
    // maintainer assets filtered.
    expect(existsSync(join(targets.claudeHome(), "skills", "alpha", "SOURCE.md"))).toBe(false);
    expect(existsSync(join(targets.claudeHome(), "skills", "alpha", "_unshipped"))).toBe(false);
    // ledger reflects it.
    expect(readLedger(targets)?.skills.map((e) => e.name)).toContain("alpha");
  });

  test("(b) disable-model-invocation skill writes agentsHome/skills/<n>/agents/openai.yaml", async () => {
    seedSkill("manual", { disableModelInvocation: true });
    const spy = makeSpy();
    await Effect.runPromise(
      runDeploy(fx(spy.port), {
        selection: resolved({ skills: ["manual"], targets: ["claude", "codex"] }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );
    const sidecar = join(targets.agentsHome(), "skills", "manual", "agents", "openai.yaml");
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(sidecar, "utf8")).toContain("allow_implicit_invocation: false");
    // claude home does NOT get the codex sidecar.
    expect(
      existsSync(join(targets.claudeHome(), "skills", "manual", "agents", "openai.yaml")),
    ).toBe(false);
  });

  test("(c) instructions overwrite + backup of a pre-existing CLAUDE.md", async () => {
    seedInstruction("core", "NEW CORE BODY");
    const claudeMd = join(targets.claudeHome(), "CLAUDE.md");
    mkdirSync(targets.claudeHome(), { recursive: true });
    writeFileSync(claudeMd, "OLD USER CONTENT");

    const spy = makeSpy();
    await Effect.runPromise(
      runDeploy(fx(spy.port), {
        selection: resolved({ instructions: ["core"], targets: ["claude"] }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );

    expect(existsSync(`${claudeMd}.hive-bak`)).toBe(true);
    expect(readFileSync(`${claudeMd}.hive-bak`, "utf8")).toBe("OLD USER CONTENT");
    expect(readFileSync(claudeMd, "utf8")).toContain("NEW CORE BODY");
  });

  test("(c2) a second deploy does NOT clobber the user's original .hive-bak backup", async () => {
    seedInstruction("core", "KIT BODY V1");
    const claudeMd = join(targets.claudeHome(), "CLAUDE.md");
    mkdirSync(targets.claudeHome(), { recursive: true });
    writeFileSync(claudeMd, "ORIGINAL USER CONTENT");
    const spy = makeSpy();
    const deployOnce = () =>
      Effect.runPromise(
        runDeploy(fx(spy.port), {
          selection: resolved({ instructions: ["core"], targets: ["claude"] }),
          kitSha: "sha1",
          kitVersion: "1.0.0",
        }),
      );
    await deployOnce(); // backup = original
    await deployOnce(); // must NOT overwrite backup with the Kit-generated file
    // The backup still holds the user's ORIGINAL, not the Kit body.
    expect(readFileSync(`${claudeMd}.hive-bak`, "utf8")).toBe("ORIGINAL USER CONTENT");
  });

  test("(d) skip-env: plugin+bundle never exec, but land in the ledger", async () => {
    process.env.AGENT_KIT_SKIP_PLUGIN_INSTALL = "1";
    process.env.AGENT_KIT_SKIP_BUNDLE_INSTALL = "1";
    seedPlugin("plg");
    seedBundle("bnd");
    const spy = makeSpy();

    const result = await Effect.runPromise(
      runDeploy(fx(spy.port), {
        selection: resolved({ plugins: ["plg"], bundles: ["bnd"], targets: ["claude"] }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );

    expect(spy.calls.length).toBe(0);
    const ledger = readLedger(targets);
    expect(ledger?.plugins.map((e) => e.name)).toContain("plg");
    expect(ledger?.bundles.map((e) => e.name)).toContain("bnd");
    expect(result.perKind.find((k) => k.kind === "plugin")?.applied).toContain("plg");
    expect(result.perKind.find((k) => k.kind === "bundle")?.applied).toContain("bnd");
  });

  test("(e) missing binary: probe false for claude -> DeployError missing_binary, nothing written", async () => {
    seedPlugin("plg");
    const spy = makeSpy();
    const exit = await Effect.runPromiseExit(
      runDeploy(
        fx(spy.port, (n) => n !== "claude"),
        {
          selection: resolved({ plugins: ["plg"], targets: ["claude"] }),
          kitSha: "sha1",
          kitVersion: "1.0.0",
        },
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).reason).toBe("missing_binary");
      expect((err as DeployError).tool).toBe("claude");
    }
    // Pre-flight aborts before any write — no ledger, no exec.
    expect(existsSync(targets.ledgerPath())).toBe(false);
    expect(spy.calls.length).toBe(0);
  });

  test("(f) not_redirected guard: a non-redirected targets refuses the real installer", async () => {
    seedPlugin("plg");
    // Hand-made targets whose isChildEnvRedirected() === false.
    const guardTargets: DeployTargets = {
      ...targets,
      isChildEnvRedirected: () => false,
    };
    const spy = makeSpy();
    const guardFx: DeployFsExec = { targets: guardTargets, exec: spy.port, probe: () => true };

    const exit = await Effect.runPromiseExit(
      runDeploy(guardFx, {
        selection: resolved({ plugins: ["plg"], targets: ["claude"] }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).reason).toBe("not_redirected");
    }
  });

  test("(g) re-deploy idempotent: {a,b} then {a} prunes b, keeps a", async () => {
    seedSkill("a");
    seedSkill("b");
    const spy = makeSpy();

    await Effect.runPromise(
      runDeploy(fx(spy.port), {
        selection: resolved({ skills: ["a", "b"], targets: ["claude"] }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );
    expect(existsSync(join(targets.claudeHome(), "skills", "a", "SKILL.md"))).toBe(true);
    expect(existsSync(join(targets.claudeHome(), "skills", "b", "SKILL.md"))).toBe(true);

    const result = await Effect.runPromise(
      runDeploy(fx(spy.port), {
        selection: resolved({ skills: ["a"], targets: ["claude"] }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );

    expect(existsSync(join(targets.claudeHome(), "skills", "a", "SKILL.md"))).toBe(true);
    expect(existsSync(join(targets.claudeHome(), "skills", "b"))).toBe(false); // pruned
    expect(readLedger(targets)?.skills.map((e) => e.name)).toEqual(["a"]);
    expect(result.pruned.some((p) => p.kind === "skill" && p.name === "b")).toBe(true);
  });

  test("(h) partial deploy: bundle exec fails after skills+instructions write", async () => {
    seedSkill("s1");
    seedInstruction("core", "INSTR BODY");
    seedBundle("bnd");
    // probe true (binaries present), exec returns non-zero for the bundle.
    const spy = makeSpy((req) => (req.command === "bash" ? 1 : 0));

    const result = await Effect.runPromise(
      runDeploy(fx(spy.port), {
        selection: resolved({
          skills: ["s1"],
          instructions: ["core"],
          bundles: ["bnd"],
          targets: ["claude"],
        }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );

    // skills + instructions landed.
    expect(result.perKind.find((k) => k.kind === "skill")?.applied).toContain("s1");
    expect(result.perKind.find((k) => k.kind === "instruction")?.applied).toContain("core");
    expect(existsSync(join(targets.claudeHome(), "skills", "s1", "SKILL.md"))).toBe(true);
    expect(existsSync(join(targets.claudeHome(), "CLAUDE.md"))).toBe(true);
    // bundle failed.
    const bundleK = result.perKind.find((k) => k.kind === "bundle");
    expect(bundleK?.applied).not.toContain("bnd");
    expect(bundleK?.failed.some((f) => f.name === "bnd")).toBe(true);
    // ledger records what landed (skills present; failed bundle absent).
    const ledger = readLedger(targets);
    expect(ledger?.skills.map((e) => e.name)).toContain("s1");
    expect(ledger?.bundles.map((e) => e.name)).not.toContain("bnd");

    // re-deploy idempotent: a clean redeploy of the same selection (bundle now ok)
    // converges.
    const ok = makeSpy(() => 0);
    const result2 = await Effect.runPromise(
      runDeploy(fx(ok.port), {
        selection: resolved({
          skills: ["s1"],
          instructions: ["core"],
          bundles: ["bnd"],
          targets: ["claude"],
        }),
        kitSha: "sha1",
        kitVersion: "1.0.0",
      }),
    );
    expect(result2.perKind.find((k) => k.kind === "bundle")?.applied).toContain("bnd");
    expect(existsSync(join(targets.claudeHome(), "skills", "s1", "SKILL.md"))).toBe(true);
  });
});
