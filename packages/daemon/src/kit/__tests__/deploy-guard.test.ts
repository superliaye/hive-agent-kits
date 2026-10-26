// Regression guard for the production-deploy 500 (the not_redirected guard +
// childEnv HOME-redirect firing in PRODUCTION, where deploying to the real home
// is the entire point). The A0 blast-radius guard must protect Hive's own test
// suite WITHOUT blocking a real deploy.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DeployFsExec,
  type ExecRequest,
  type ExecResult,
  execInstaller,
  repoCommandEnv,
} from "../deploy/adapter.ts";
import { DeployError } from "../effect/errors.ts";
import {
  type DeployHomes,
  type DeployTargets,
  defaultDeployTargets,
  failSafeDeployTargets,
} from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

// Packaged port: real homes, the production deploy target.
const packagedOpts = { devMode: false, allowRealHomeDeploy: () => false } as const;

function fakeTargets(
  redirected: boolean,
  homes: DeployHomes = {
    claudeHome: "/tmp/c",
    codexHome: "/tmp/cx",
    agentsHome: "/tmp/a",
    ledgerPath: "/tmp/l",
  },
): DeployTargets {
  return {
    claudeHome: () => homes.claudeHome,
    codexHome: () => homes.codexHome,
    agentsHome: () => homes.agentsHome,
    ledgerPath: () => homes.ledgerPath,
    mirrorRoot: (sourceId: string) => `/tmp/m/${sourceId}`,
    deploymentStatePath: () => "/tmp/deployment-state.json",
    kitTmpRoot: () => "/tmp/t",
    starterRoot: () => "/tmp/starter",
    childEnv: (base) => ({ ...base }),
    isChildEnvRedirected: () => redirected,
    withHomes: (fixed) => fakeTargets(redirected, fixed),
  };
}

function recordingFx(redirected: boolean): { fx: DeployFsExec; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  const exec = async (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { fx: { targets: fakeTargets(redirected), exec, probe: async () => true }, calls };
}

async function withNodeEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

describe("execInstaller redirection guard", () => {
  test("PRODUCTION (not a test) runs the installer even when not redirected", async () => {
    const { fx, calls } = recordingFx(false);
    await withNodeEnv("production", async () => {
      const r = await execInstaller(
        fx,
        { command: "claude", args: ["plugin", "install"] },
        "claude",
      );
      expect(r.status).toBe(0);
    });
    expect(calls).toHaveLength(1);
  });

  test("TEST context still refuses a real installer when not redirected", async () => {
    const { fx, calls } = recordingFx(false);
    await withNodeEnv("test", async () => {
      let thrown: unknown;
      try {
        await execInstaller(fx, { command: "claude", args: ["plugin", "install"] }, "claude");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DeployError);
      expect((thrown as DeployError).reason).toBe("not_redirected");
    });
    expect(calls).toHaveLength(0);
  });

  test("a redirected home runs the installer in any context", async () => {
    const { fx, calls } = recordingFx(true);
    await withNodeEnv("test", () =>
      execInstaller(fx, { command: "npx", args: ["skills", "add"] }, "npx"),
    );
    expect(calls).toHaveLength(1);
  });

  test("the installer env carries Hive's Codex home over a CODEX_HOME the shell exported", async () => {
    const homes = redirectHomeEnv(join(tmpdir(), `hive-codex-home-${process.pid}`));
    const exported = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(tmpdir(), "elsewhere", ".codex");
    try {
      const seen: NodeJS.ProcessEnv[] = [];
      const fx: DeployFsExec = {
        targets: failSafeDeployTargets(),
        exec: async (_req, env) => {
          seen.push(env);
          return { status: 0, stdout: "", stderr: "" };
        },
        probe: async () => true,
      };
      await execInstaller(fx, { command: "codex", args: ["plugin", "add", "p@m"] }, "codex");
      expect(seen.map((env) => env.CODEX_HOME)).toEqual([homes.codexHome]);
    } finally {
      if (exported === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = exported;
      clearHomeEnv();
    }
  });
});

describe("childEnv HOME redirection", () => {
  function withoutHiveEnv<T>(fn: () => T): T {
    const keys = ["HIVE_CLAUDE_HOME", "HIVE_CODEX_HOME", "HIVE_AGENTS_HOME", "HIVE_RUNTIME_ROOT"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    try {
      return fn();
    } finally {
      for (const k of keys) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("PACKAGED (real homes) leaves the real HOME/USERPROFILE intact", () => {
    withoutHiveEnv(() => {
      const targets = defaultDeployTargets(packagedOpts);
      const base: NodeJS.ProcessEnv = { HOME: "/real/home", USERPROFILE: "C:\\real\\home" };
      const env = targets.childEnv(base);
      expect(env.HOME).toBe("/real/home");
      expect(env.USERPROFILE).toBe("C:\\real\\home");
      // CLAUDE_CONFIG_DIR is still pinned (equals the real ~/.claude in production).
      expect(env.CLAUDE_CONFIG_DIR).toBeDefined();
    });
  });

  test("PACKAGED pins CODEX_HOME to the real ~/.codex, not the shell's", () => {
    withoutHiveEnv(() => {
      const targets = defaultDeployTargets(packagedOpts);
      const env = targets.childEnv({ HOME: "/real/home", CODEX_HOME: "/elsewhere/.codex" });
      expect(env.CODEX_HOME).toBe(join(homedir(), ".codex"));
    });
  });

  test("DEV SANDBOX (toggle off) points HOME/USERPROFILE at the sandbox parent", () => {
    const prev = process.env.HIVE_RUNTIME_ROOT;
    process.env.HIVE_RUNTIME_ROOT = "/tmp/redirected-hive";
    try {
      const targets = defaultDeployTargets({ devMode: true, allowRealHomeDeploy: () => false });
      const env = targets.childEnv({ HOME: "/real/home" });
      // childEnv points $HOME at the parent of the resolved claude home so an
      // installer's ~/.codex / ~/.agents land on the sandbox tree (B2a). Built
      // with join() so the OS separators match (Windows backslashes).
      const sandboxParent = join("/tmp/redirected-hive", "homes");
      expect(env.HOME).toBe(sandboxParent);
      expect(env.USERPROFILE).toBe(sandboxParent);
      // The resolved claude home nests under that parent (B2a invariant).
      expect(targets.claudeHome()).toBe(join(sandboxParent, ".claude"));
    } finally {
      if (prev === undefined) delete process.env.HIVE_RUNTIME_ROOT;
      else process.env.HIVE_RUNTIME_ROOT = prev;
    }
  });
});

describe("repository command env", () => {
  test("keeps the redirected homes and drops every other path into the real home", () => {
    // The dev sandbox layout: the redirected homes live inside the real home.
    // repoCommandEnv only computes, so this root is never created.
    const realHome = homedir();
    const homes = redirectHomeEnv(join(realHome, `.hive-repo-env-${process.pid}`));
    try {
      const env = repoCommandEnv(failSafeDeployTargets(), {
        HOME: realHome,
        PATH: `${join(realHome, "bin")}:/usr/bin`,
        XDG_CACHE_HOME: join(realHome, ".cache"),
        HIVE_RUNTIME_ROOT: homes.runtimeRoot,
        CODEX_HOME: join(realHome, ".codex"),
        LANG: "C.UTF-8",
      });
      expect(env.HOME).toBe(dirname(homes.claudeHome));
      expect(env.CLAUDE_CONFIG_DIR).toBe(homes.claudeHome);
      expect(env.CODEX_HOME).toBe(homes.codexHome);
      expect(env.PATH).toStartWith(join(realHome, "bin"));
      expect(env.XDG_CACHE_HOME).toBeUndefined();
      expect(env.HIVE_RUNTIME_ROOT).toBeUndefined();
      expect(env.LANG).toBe("C.UTF-8");
      expect(existsSync(homes.root)).toBe(false);
    } finally {
      clearHomeEnv();
    }
  });
});
