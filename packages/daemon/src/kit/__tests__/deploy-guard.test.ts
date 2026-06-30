// Regression guard for the production-deploy 500 (the not_redirected guard +
// childEnv HOME-redirect firing in PRODUCTION, where deploying to the real home
// is the entire point). The A0 blast-radius guard must protect Hive's own test
// suite WITHOUT blocking a real deploy.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type DeployFsExec,
  type ExecRequest,
  type ExecResult,
  execInstaller,
} from "../deploy/adapter.ts";
import { DeployError } from "../effect/errors.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";

// Packaged port: real homes, the production deploy target.
const packagedOpts = { devMode: false, allowRealHomeDeploy: () => false } as const;

function fakeTargets(redirected: boolean): DeployTargets {
  return {
    claudeHome: () => "/tmp/c",
    codexHome: () => "/tmp/cx",
    agentsHome: () => "/tmp/a",
    ledgerPath: () => "/tmp/l",
    mirrorRoot: (sourceId: string) => `/tmp/m/${sourceId}`,
    fingerprintPath: () => "/tmp/f",
    kitTmpRoot: () => "/tmp/t",
    starterRoot: () => "/tmp/starter",
    childEnv: (base) => ({ ...base }),
    isChildEnvRedirected: () => redirected,
  };
}

function recordingFx(redirected: boolean): { fx: DeployFsExec; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  const exec = (req: ExecRequest): ExecResult => {
    calls.push(req);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { fx: { targets: fakeTargets(redirected), exec, probe: () => true }, calls };
}

function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

describe("execInstaller redirection guard", () => {
  test("PRODUCTION (not a test) runs the installer even when not redirected", () => {
    const { fx, calls } = recordingFx(false);
    withNodeEnv("production", () => {
      const r = execInstaller(fx, { command: "claude", args: ["plugin", "install"] }, "claude");
      expect(r.status).toBe(0);
    });
    expect(calls).toHaveLength(1);
  });

  test("TEST context still refuses a real installer when not redirected", () => {
    const { fx, calls } = recordingFx(false);
    withNodeEnv("test", () => {
      let thrown: unknown;
      try {
        execInstaller(fx, { command: "claude", args: ["plugin", "install"] }, "claude");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DeployError);
      expect((thrown as DeployError).reason).toBe("not_redirected");
    });
    expect(calls).toHaveLength(0);
  });

  test("a redirected home runs the installer in any context", () => {
    const { fx, calls } = recordingFx(true);
    withNodeEnv("test", () => {
      execInstaller(fx, { command: "npx", args: ["skills", "add"] }, "npx");
    });
    expect(calls).toHaveLength(1);
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
