// Agent Catalog factory per ADR-0007.
//
// Holds resolved Agents (runtime fork > bundled). updateBindings always
// writes to the runtime tier — bundled HARNESS.md is never touched.
// Emits typed events the audit subscriber attaches to.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { HarnessManifest } from "../capabilities/schemas.ts";
import { log } from "../lib/log.ts";
import { runtime } from "../lib/paths.ts";
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
  };
  // Sanity-check before writing.
  HarnessManifest.parse(manifest);
  mkdirSync(dirname(path), { recursive: true });
  const yamlBlock = stringifyYaml(manifest).trimEnd();
  const body = agent.promptBody.startsWith("\n") ? agent.promptBody : `\n${agent.promptBody}`;
  const content = `---\n${yamlBlock}\n---${body}`;
  writeFileSync(path, content, "utf8");
}

export function createCatalog(opts: CreateCatalogOptions = {}): Catalog {
  const events = new TypedEmitter<CatalogEvents>();
  const scanner = opts.scanner ?? scanAll;
  const logErrors = opts.logErrors ?? true;

  let current = new Map<string, Agent>();
  let started = false;

  async function performScan(emitAsDiff: boolean): Promise<void> {
    const { agents, errors } = scanner();
    if (logErrors) {
      for (const e of errors) {
        log().warn({ module: "catalog", path: e.path, err: e.message }, "skipped malformed manifest");
      }
    }
    const next = new Map<string, Agent>(agents.map((a) => [a.agentId, a]));

    if (!emitAsDiff) {
      for (const a of next.values()) {
        await events.emit("agent.created", { agentId: a.agentId, path: a.path });
      }
      current = next;
      return;
    }

    for (const [id, a] of next) {
      if (!current.has(id)) {
        await events.emit("agent.created", { agentId: id, path: a.path });
      }
    }
    for (const [id] of current) {
      if (!next.has(id)) {
        await events.emit("agent.destroyed", { agentId: id });
      }
    }
    current = next;
  }

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
    await performScan(true);
    const a = current.get(agentId);
    if (!a) throw new AgentNotFoundError(agentId);
    return a;
  }

  return {
    list() {
      return Array.from(current.values());
    },
    get(agentId) {
      return current.get(agentId);
    },
    async updateBindings(agentId, patches, source = "ui") {
      if (patches.length === 0) {
        throw new Error("updateBindings requires at least one patch");
      }
      const agent = current.get(agentId);
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
      };
      // Single write — all-or-nothing for the batch.
      writeHarness(runtimePath, forked);

      // Re-read from disk so the cached Agent matches what's persisted —
      // catches any subtle YAML round-trip drift.
      const refreshed = await refreshOne(agentId);
      await events.emit("harness.updated", {
        agentId,
        source,
        diff: patches,
      });
      return refreshed;
    },
    async resetToBundled(agentId) {
      const agent = current.get(agentId);
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
    async start() {
      if (started) return;
      started = true;
      await performScan(false);
    },
    async rescan() {
      await performScan(true);
    },
    events,
    dispose() {
      // No external resources today (no watcher). Reserved for symmetry
      // with Registry — a future hot-reload watcher would close here.
    },
  };
}
