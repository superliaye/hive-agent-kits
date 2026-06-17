import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { LoaderResult } from "../../loader.ts";
import { createRegistry } from "../../registry.ts";
import type { SkillCapability } from "../../types.ts";
import { BindingResolver, BindingResolverLive } from "../binding-resolver.ts";

function skill(name: string): SkillCapability {
  return {
    kind: "skill",
    name,
    description: `${name} description`,
    origin: "personal",
    source: "filesystem",
    layer: "bundled",
    path: `/fake/skills/${name}/SKILL.md`,
    manifest: { name, description: `${name} description` },
    body: `# ${name}\nbody`,
  };
}

async function resolverFor(scan: () => LoaderResult) {
  const registry = createRegistry({ scanner: scan, watch: false, logErrors: false });
  await registry.start();
  return Effect.runPromise(Effect.provide(BindingResolver, BindingResolverLive(registry)));
}

describe("BindingResolver — resolveSkills", () => {
  test("hit: bound names resolve in order, de-duplicated, with body + path + origin", async () => {
    const svc = await resolverFor(() => ({
      capabilities: [skill("alpha"), skill("beta")],
      errors: [],
    }));

    const res = await Effect.runPromise(svc.resolveSkills(["beta", "alpha", "beta"]));

    expect(res.missing).toEqual([]);
    expect(res.resolved.map((s) => s.name)).toEqual(["beta", "alpha"]);
    const beta = res.resolved[0];
    expect(beta?.description).toBe("beta description");
    expect(beta?.body).toBe("# beta\nbody");
    expect(beta?.path).toBe("/fake/skills/beta/SKILL.md");
    expect(beta?.origin).toBe("personal");
  });

  test("miss: an unknown binding is collected into `missing`, never thrown", async () => {
    const svc = await resolverFor(() => ({ capabilities: [skill("alpha")], errors: [] }));

    const res = await Effect.runPromise(svc.resolveSkills(["alpha", "ghost"]));

    expect(res.resolved.map((s) => s.name)).toEqual(["alpha"]);
    expect(res.missing).toEqual(["ghost"]);
  });

  test("malformed: a loader-skipped manifest never reaches the Registry, so its binding misses", async () => {
    // The loader rejects the malformed manifest into `errors`; it is absent
    // from `capabilities`, so resolving its name behaves exactly like a miss.
    const svc = await resolverFor(() => ({
      capabilities: [skill("alpha")],
      errors: [{ path: "/fake/skills/broken/SKILL.md", message: "no YAML frontmatter" }],
    }));

    const res = await Effect.runPromise(svc.resolveSkills(["alpha", "broken"]));

    expect(res.resolved.map((s) => s.name)).toEqual(["alpha"]);
    expect(res.missing).toEqual(["broken"]);
  });

  test("empty bindings: resolves to nothing, no misses", async () => {
    const svc = await resolverFor(() => ({ capabilities: [skill("alpha")], errors: [] }));

    const res = await Effect.runPromise(svc.resolveSkills([]));

    expect(res.resolved).toEqual([]);
    expect(res.missing).toEqual([]);
  });
});
