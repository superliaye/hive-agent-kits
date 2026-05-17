/**
 * Agent Catalog behaviour — fork-on-write semantics per ADR-0007.
 *
 * Covers:
 *   - start() emits agent.created for bundled agents
 *   - updateBindings writes to runtime tier; bundled file is never touched
 *   - resetToBundled deletes the runtime fork and re-resolves to bundled
 *   - harness.updated event payload carries the diff
 *   - runtime fork shadows bundled when both exist
 *   - unknown agentId throws AgentNotFoundError
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentNotFoundError, createCatalog } from "../catalog.ts";
import type { CatalogEvents } from "../types.ts";

const HARNESS_TEMPLATE = (agentId: string, extraSkill?: string): string => `---
agentId: ${agentId}
backend: native
domain: ${agentId} domain
bindings:
  skills:${extraSkill ? `\n    - ${extraSkill}` : " []"}
  snippets: []
  tools:
    - ask_user
    - memory_read
  mcp: []
config:
  model: claude-opus-4-7
---

# ${agentId}

Stub body.
`;

describe("createCatalog — real filesystem fork-on-write", () => {
  let bundledRoot: string;
  let runtimeRoot: string;

  beforeEach(() => {
    bundledRoot = mkdtempSync(join(tmpdir(), "hive-bundled-"));
    runtimeRoot = mkdtempSync(join(tmpdir(), "hive-runtime-"));
    process.env.HIVE_BUNDLED_ROOT = bundledRoot;
    process.env.HIVE_RUNTIME_ROOT = runtimeRoot;
  });

  afterEach(() => {
    delete process.env.HIVE_BUNDLED_ROOT;
    delete process.env.HIVE_RUNTIME_ROOT;
    if (existsSync(bundledRoot)) rmSync(bundledRoot, { recursive: true, force: true });
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
  });

  function writeBundledHarness(agentId: string, withSkill = "alpha"): void {
    const dir = join(bundledRoot, "agents", agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "HARNESS.md"), HARNESS_TEMPLATE(agentId, withSkill));
  }

  test("start() emits agent.created for each bundled agent", async () => {
    writeBundledHarness("root");
    writeBundledHarness("agent-manager");

    const catalog = createCatalog({ logErrors: false });
    const created: CatalogEvents["agent.created"][] = [];
    catalog.events.on("agent.created", (e) => {
      created.push(e);
    });
    await catalog.start();

    expect(created.map((e) => e.agentId).sort()).toEqual(["agent-manager", "root"]);
    expect(catalog.list()).toHaveLength(2);
    expect(catalog.get("root")?.layer).toBe("bundled");
    expect(catalog.get("root")?.hasFork).toBe(false);
  });

  test("updateBindings(unbind) writes a runtime fork and never touches bundled", async () => {
    writeBundledHarness("root", "alpha");
    const bundledPath = join(bundledRoot, "agents", "root", "HARNESS.md");
    const bundledBefore = readFileSync(bundledPath, "utf8");

    const catalog = createCatalog({ logErrors: false });
    await catalog.start();
    const updated: CatalogEvents["harness.updated"][] = [];
    catalog.events.on("harness.updated", (e) => {
      updated.push(e);
    });

    const result = await catalog.updateBindings("root", {
      kind: "skill",
      name: "alpha",
      action: "unbind",
    });

    expect(result.layer).toBe("runtime");
    expect(result.hasFork).toBe(true);
    expect(result.bindings.skills).not.toContain("alpha");

    const runtimePath = join(runtimeRoot, "agents", "root", "HARNESS.md");
    expect(existsSync(runtimePath)).toBe(true);
    expect(readFileSync(bundledPath, "utf8")).toBe(bundledBefore);

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      agentId: "root",
      source: "ui",
      diff: { kind: "skill", name: "alpha", action: "unbind" },
    });
  });

  test("updateBindings(bind) adds to the slot without duplicates", async () => {
    writeBundledHarness("root", "alpha");
    const catalog = createCatalog({ logErrors: false });
    await catalog.start();

    await catalog.updateBindings("root", { kind: "tool", name: "ask_user", action: "bind" });
    const result = await catalog.updateBindings("root", {
      kind: "tool",
      name: "save_artifact",
      action: "bind",
    });

    expect(result.bindings.tools).toEqual(["ask_user", "memory_read", "save_artifact"]);
  });

  test("resetToBundled deletes the fork and re-resolves to bundled", async () => {
    writeBundledHarness("root", "alpha");
    const catalog = createCatalog({ logErrors: false });
    await catalog.start();
    await catalog.updateBindings("root", { kind: "skill", name: "alpha", action: "unbind" });

    const runtimePath = join(runtimeRoot, "agents", "root", "HARNESS.md");
    expect(existsSync(runtimePath)).toBe(true);

    const reset = await catalog.resetToBundled("root");
    expect(existsSync(runtimePath)).toBe(false);
    expect(reset.layer).toBe("bundled");
    expect(reset.hasFork).toBe(false);
    expect(reset.bindings.skills).toContain("alpha");
  });

  test("runtime fork shadows bundled at startup", async () => {
    writeBundledHarness("root", "alpha");
    // Pre-create a runtime fork.
    const runtimeDir = join(runtimeRoot, "agents", "root");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "HARNESS.md"), HARNESS_TEMPLATE("root", "beta"));

    const catalog = createCatalog({ logErrors: false });
    await catalog.start();

    const root = catalog.get("root");
    expect(root?.layer).toBe("runtime");
    expect(root?.hasFork).toBe(true);
    expect(root?.bindings.skills).toEqual(["beta"]);
  });

  test("unknown agentId throws AgentNotFoundError", async () => {
    const catalog = createCatalog({ logErrors: false });
    await catalog.start();
    await expect(
      catalog.updateBindings("nonexistent", { kind: "skill", name: "x", action: "bind" }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });
});
