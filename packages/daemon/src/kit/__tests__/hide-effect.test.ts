//  toggle hide-effect (kit boundary). Deactivating a git Source removes its
// capabilities from the catalog and PROMOTES a capability it was shadowing
// (provided by another active Source) to the deployable winner; reactivating
// restores the hidden capability and re-shadows the other Source. Driven through
// the real Kit service over a memory registry; Mirrors are written directly to
// disk (no sync, no network). mode:"memory", no fs.watch, no clone paths.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEntry, Source } from "@hive/contract";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SourceRegistry, SourceRegistryLive } from "../../sources/effect/sources-live.ts";
import { Kit, KitLive } from "../effect/kit-live.ts";
import { type HttpFetch } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

// Any fetch means a code path wrongly went to the network — these tests read
// pre-written Mirrors, never sync.
const NEVER_FETCH: HttpFetch = async () => {
  throw new Error("hide-effect tests must not fetch");
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-hide-"));
  redirectHomeEnv(tmpRoot);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function gitSource(id: string, active: boolean, createdAt: number): Source {
  // `createdAt` encodes the intended order; reuse it as the stored precedence rank.
  return {
    id,
    label: id,
    locator: {
      kind: "git",
      repoUrl: `https://github.com/owner/${id}`,
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    },
    origin: `https://github.com/owner/${id}`,
    kind: "git",
    active,
    createdAt,
    rank: createdAt,
  };
}

function writeSkillIn(mirrorRoot: string, name: string, frontmatter: string, body: string): void {
  const dir = join(mirrorRoot, "capabilities", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

function kitOver(sources: Source[]) {
  const sourcesLayer = SourceRegistryLive({ mode: "memory", initial: sources });
  const rt = ManagedRuntime.make(
    Layer.merge(KitLive({ fetch: NEVER_FETCH }).pipe(Layer.provide(sourcesLayer)), sourcesLayer),
  );
  return { kit: rt.runSync(Kit), registry: rt.runSync(SourceRegistry), rt };
}

function entriesNamed(entries: CapabilityEntry[], name: string): CapabilityEntry[] {
  return entries.filter((e) => e.kind === "skill" && e.name === name);
}
function winner(entries: CapabilityEntry[], name: string): CapabilityEntry | undefined {
  return entriesNamed(entries, name).find((e) => e.deployable);
}

describe("Kit.catalog — toggle hide-effect", () => {
  test("deactivate promotes the shadow; reactivate restores + re-shadows", async () => {
    // A and B both provide skill `x` with DIFFERENT content (collision); A also
    // provides a unique skill `y`. B inserted later → B wins `x`, A is shadowed.
    const A = gitSource("src-a", true, 0);
    const B = gitSource("src-b", true, 1);
    const mirrorA = failSafeDeployTargets().mirrorRoot(A.id);
    const mirrorB = failSafeDeployTargets().mirrorRoot(B.id);
    writeSkillIn(mirrorA, "x", "name: x\ndescription: x from A", "A body");
    writeSkillIn(mirrorA, "y", "name: y\ndescription: y only in A", "y body");
    writeSkillIn(mirrorB, "x", "name: x\ndescription: x from B", "B body");

    const { kit, registry, rt } = kitOver([A, B]);
    try {
      // Both active: x winner = B, a shadowed row for A; y present (from A).
      let cat = kit.catalog();
      expect(entriesNamed(cat.entries, "x").length).toBe(2);
      expect(winner(cat.entries, "x")?.sourceIds[0]).toBe("src-b");
      expect(
        entriesNamed(cat.entries, "x").some((e) => e.shadowed && e.sourceIds[0] === "src-a"),
      ).toBe(true);
      expect(winner(cat.entries, "y")?.sourceIds[0]).toBe("src-a");

      // Deactivate A: y gone; x winner promoted to B (B was already winner, but now
      // there is NO shadow — A's variant is hidden, not just shadowed).
      await Effect.runPromise(registry.deactivate("src-a"));
      cat = kit.catalog();
      expect(entriesNamed(cat.entries, "y").length).toBe(0);
      const xAfterOff = entriesNamed(cat.entries, "x");
      expect(xAfterOff.length).toBe(1);
      expect(xAfterOff[0]?.deployable).toBe(true);
      expect(xAfterOff[0]?.sourceIds[0]).toBe("src-b");
      expect(xAfterOff[0]?.shadowed).toBe(false);

      // Reactivate A: y back, x winner = B again, A re-shadowed.
      await Effect.runPromise(registry.activate("src-a"));
      cat = kit.catalog();
      expect(winner(cat.entries, "y")?.sourceIds[0]).toBe("src-a");
      expect(entriesNamed(cat.entries, "x").length).toBe(2);
      expect(winner(cat.entries, "x")?.sourceIds[0]).toBe("src-b");
      expect(
        entriesNamed(cat.entries, "x").some((e) => e.shadowed && e.sourceIds[0] === "src-a"),
      ).toBe(true);
    } finally {
      rt.dispose();
    }
  });

  test("deactivating the WINNER promotes the formerly-shadowed Source to winner", async () => {
    // Symmetric promotion: A and B collide on `x`; B wins. Deactivating B promotes
    // A to the deployable winner (the formerly-shadowed loser).
    const A = gitSource("src-a", true, 0);
    const B = gitSource("src-b", true, 1);
    writeSkillIn(
      failSafeDeployTargets().mirrorRoot(A.id),
      "x",
      "name: x\ndescription: A",
      "A body",
    );
    writeSkillIn(
      failSafeDeployTargets().mirrorRoot(B.id),
      "x",
      "name: x\ndescription: B",
      "B body",
    );

    const { kit, registry, rt } = kitOver([A, B]);
    try {
      expect(winner(kit.catalog().entries, "x")?.sourceIds[0]).toBe("src-b");
      await Effect.runPromise(registry.deactivate("src-b"));
      const x = entriesNamed(kit.catalog().entries, "x");
      expect(x.length).toBe(1);
      expect(x[0]?.deployable).toBe(true);
      expect(x[0]?.sourceIds[0]).toBe("src-a");
      expect(x[0]?.shadowed).toBe(false);
    } finally {
      rt.dispose();
    }
  });
});
