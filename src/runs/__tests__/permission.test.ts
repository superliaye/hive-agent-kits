import { describe, expect, test } from "bun:test";
import type { Agent, Catalog } from "../../catalog/index.ts";
import { createDefaultPermission } from "../permission.ts";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "a",
    backend: "native",
    domain: "t",
    bindings: { skills: [], snippets: [], tools: ["run_shell"], mcp: [] },
    config: {},
    promptBody: "",
    layer: "bundled",
    hasFork: false,
    path: "/p",
    ...overrides,
  };
}

function catalogWith(agent: Agent): Pick<Catalog, "get"> {
  return { get: (id) => (id === agent.agentId ? agent : undefined) };
}

const req = (command: string) => ({
  agentId: "a",
  runId: "r",
  tool: "run_shell",
  command,
});

describe("default PermissionPort — run_shell (deny-by-default)", () => {
  test("allowlisted command is allowed", async () => {
    const perm = createDefaultPermission(catalogWith(makeAgent({ commandAllowlist: ["node"] })));
    expect((await perm.decide(req("node"))).outcome).toBe("allow");
  });

  test("not-allowlisted command is denied", async () => {
    const perm = createDefaultPermission(catalogWith(makeAgent({ commandAllowlist: ["node"] })));
    expect((await perm.decide(req("python"))).outcome).toBe("deny");
  });

  test("absent allowlist denies (deny-by-default)", async () => {
    const perm = createDefaultPermission(catalogWith(makeAgent({})));
    expect((await perm.decide(req("node"))).outcome).toBe("deny");
  });

  test("empty allowlist denies (deny-by-default)", async () => {
    const perm = createDefaultPermission(catalogWith(makeAgent({ commandAllowlist: [] })));
    expect((await perm.decide(req("node"))).outcome).toBe("deny");
  });

  test("destructive command denied even when allowlisted (hard floor)", async () => {
    const perm = createDefaultPermission(catalogWith(makeAgent({ commandAllowlist: ["rm"] })));
    const d = await perm.decide(req("rm"));
    expect(d.outcome).toBe("deny");
    expect(d.reason).toContain("destructive");
  });

  test("destructive match is basename-aware (path-qualified rm denied)", async () => {
    const perm = createDefaultPermission(catalogWith(makeAgent({ commandAllowlist: ["/bin/rm"] })));
    expect((await perm.decide(req("/bin/rm"))).outcome).toBe("deny");
  });

  test("command-less tool is allowed (no command → no allowlist semantics)", async () => {
    const perm = createDefaultPermission(catalogWith(makeAgent({})));
    expect((await perm.decide({ agentId: "a", runId: "r", tool: "read" })).outcome).toBe("allow");
    // Even a run_shell call that projects no command is allowed (gate is
    // command-presence-driven, not tool-name-driven).
    expect((await perm.decide({ agentId: "a", runId: "r", tool: "run_shell" })).outcome).toBe(
      "allow",
    );
  });
});
