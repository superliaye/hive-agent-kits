// Agent Catalog factory per ADR-0007.
//
// Holds resolved Agents (runtime fork > bundled, with bundled fallback when
// a fork file fails to parse). updateBindings always writes to the runtime
// tier — bundled HARNESS.md is never touched. Scan + diff machinery lives
// in TieredManifestStore; this file owns the typed events, the write-back
// verbs, and the fork-write semantics.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { HarnessManifest } from "../capabilities/schemas.ts";
import { log } from "../lib/log.ts";
import { bundledRoot, runtime, runtimeRoot } from "../lib/paths.ts";
import { createTieredManifestStore } from "../lib/tiered-store.ts";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import { type LoaderResult, scanAll } from "./loader.ts";
import type { Agent, BindingKind, BindingPatch, Catalog, CatalogEvents } from "./types.ts";

const KIND_TO_FIELD: Record<BindingKind, keyof Agent["bindings"]> = {
  skill: "skills",
  snippet: "snippets",
  tool: "tools",
  mcp: "mcp",
};

export type CreateCatalogOptions = {
  scanner?: () => LoaderResult;
  watch?: boolean;
  logErrors?: boolean;
};

export class AgentNotFoundError extends Error {
  constructor(public readonly agentId: string) {
    super(`agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

function writeHarness(path: string, agent: Agent): void {
  const manifest = {
    agentId: agent.agentId,
    backend: agent.backend,
    domain: agent.domain,
    bindings: agent.bindings,
    config: agent.config,
    // Preserve the per-Agent run_shell allowlist across fork-writes (binding
    // edits) so a binding mutation never silently drops it.
    ...(agent.commandAllowlist !== undefined ? { commandAllowlist: agent.commandAllowlist } : {}),
  };
  // Sanity-check before writing.
  HarnessManifest.parse(manifest);
  mkdirSync(dirname(path), { recursive: true });
  const yamlBlock = stringifyYaml(manifest).trimEnd();
  const body = agent.promptBody.startsWith("\n") ? agent.promptBody : `\n${agent.promptBody}`;
  const content = `---\n${yamlBlock}\n---${body}`;
  writeFileSync(path, content, "utf8");
}

function sameAgent(a: Agent, b: Agent): boolean {
  return (
    a.path === b.path &&
    a.layer === b.layer &&
    a.hasFork === b.hasFork &&
    a.forkError === b.forkError
  );
}

export function createCatalog(opts: CreateCatalogOptions = {}): Catalog {
  const events = new TypedEmitter<CatalogEvents>();
  const scanner = opts.scanner ?? scanAll;
  const logErrors = opts.logErrors ?? true;

  const store = createTieredManifestStore<Agent>({
    watchRoots: [bundledRoot(), runtimeRoot()],
    watch: opts.watch,
    scan: () => {
      const { agents, errors } = scanner();
      return { items: agents, errors };
    },
    key: (a) => a.agentId,
    same: sameAgent,
    onLoaderError: logErrors
      ? (e) =>
          log().warn(
            { module: "catalog", path: e.path, err: e.message },
            "skipped malformed manifest",
          )
      : undefined,
    onRescanError: logErrors
      ? (err) => log().warn({ module: "catalog", err: err.message }, "hot-reload error")
      : undefined,
    onDiff: async ({ added, removed }) => {
      // Scan-time edits to an existing agent don't fire a typed event today;
      // user-driven mutations emit harness.updated explicitly. The trace log
      // is enough for scan-time "changed" diagnostics.
      for (const a of added) {
        await events.emit("agent.created", { agentId: a.agentId, path: a.path });
      }
      for (const a of removed) {
        await events.emit("agent.destroyed", { agentId: a.agentId });
      }
    },
  });

  function applyPatch(agent: Agent, patch: BindingPatch): Agent {
    const field = KIND_TO_FIELD[patch.kind];
    const set = new Set(agent.bindings[field] ?? []);
    if (patch.action === "bind") set.add(patch.name);
    else set.delete(patch.name);
    return {
      ...agent,
      bindings: { ...agent.bindings, [field]: Array.from(set) },
    };
  }

  function applyPatches(agent: Agent, patches: BindingPatch[]): Agent {
    let result = agent;
    for (const p of patches) result = applyPatch(result, p);
    return result;
  }

  async function refreshOne(agentId: string): Promise<Agent> {
    await store.rescan();
    const a = store.get(agentId);
    if (!a) throw new AgentNotFoundError(agentId);
    return a;
  }

  return {
    list: () => store.current(),
    get: (agentId) => store.get(agentId),
    async updateBindings(agentId, patches, source = "ui") {
      if (patches.length === 0) {
        throw new Error("updateBindings requires at least one patch");
      }
      const agent = store.get(agentId);
      if (!agent) throw new AgentNotFoundError(agentId);

      const runtimePath = join(runtime.agent(agentId), "HARNESS.md");
      // If no fork yet, the bundled body becomes the seed for the fork.
      // promptBody on the resolved agent is already correct (it came from
      // whichever layer resolved); the fork carries that forward verbatim.
      const next = applyPatches(agent, patches);
      const forked: Agent = {
        ...next,
        layer: "runtime",
        hasFork: true,
        path: runtimePath,
        forkError: undefined,
      };
      // Single write — all-or-nothing for the batch.
      writeHarness(runtimePath, forked);

      // Re-read from disk so the cached Agent matches what's persisted —
      // catches any subtle YAML round-trip drift.
      const refreshed = await refreshOne(agentId);
      await events.emit("harness.updated", { agentId, source, diff: patches });
      return refreshed;
    },
    async resetToBundled(agentId) {
      const agent = store.get(agentId);
      if (!agent) throw new AgentNotFoundError(agentId);
      const runtimePath = join(runtime.agent(agentId), "HARNESS.md");
      if (existsSync(runtimePath)) {
        rmSync(runtimePath, { force: true });
      }
      const refreshed = await refreshOne(agentId);
      await events.emit("harness.updated", {
        agentId,
        source: "reset",
        diff: { kind: "reset" },
      });
      return refreshed;
    },
    start: () => store.start(),
    rescan: () => store.rescan(),
    events,
    dispose: () => store.dispose(),
  };
}
