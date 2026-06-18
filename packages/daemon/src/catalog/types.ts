// Agent Catalog types per ADR-0007.
//
// Agents are NOT Capabilities — they live in their own index (Agent Catalog)
// and are stored as HARNESS.md files. Bundled HARNESS.md ships in the repo;
// runtime forks live in the OS app-storage dir and shadow the bundled copy.

import type { HarnessManifest } from "../capabilities/schemas.ts";
import type { AgentBackend, CapabilityLayer } from "../lib/capability-types.ts";
import type { AgentId } from "../lib/ids.ts";
import type { TypedEmitter } from "../lib/typed-emitter.ts";

// The four binding slots a HarnessManifest carries. Singular kind values
// map to plural field names internally (`skill` -> `bindings.skills`, etc.).
export type BindingKind = "skill" | "snippet" | "tool" | "mcp";

// A single binding mutation. The Catalog applies one at a time so the
// audit row carries exactly which binding changed (matches ADR-0007's
// `harness.updated` payload requirement).
export type BindingPatch = {
  kind: BindingKind;
  name: string;
  action: "bind" | "unbind";
};

// Resolved Agent record. Bundled = comes straight from the repo. Runtime =
// a fork lives in app-storage and overrides bundled. `hasFork` is true
// when a runtime HARNESS.md exists for this agent.
//
// `forkError` is populated when a runtime fork exists but failed to parse:
// the resolver falls back to the bundled file and surfaces the failure so
// the Settings UI can show a banner rather than silently ignoring edits.
export type Agent = {
  agentId: AgentId;
  backend: AgentBackend;
  domain: string;
  bindings: HarnessManifest["bindings"];
  config: HarnessManifest["config"];
  promptBody: string;
  layer: CapabilityLayer;
  hasFork: boolean;
  forkError?: string;
  // Absolute path to the manifest currently resolved (runtime fork or bundled).
  path: string;
};

export type CatalogEvents = {
  "agent.created": { agentId: AgentId; path: string };
  "agent.destroyed": { agentId: AgentId };
  "harness.updated": {
    agentId: AgentId;
    source: "ui" | "agent-manager" | "reset";
    diff: BindingPatch[] | { kind: "reset" };
  };
};

// The fields the Agent-Manager lifecycle tool supplies to create a brand-new
// runtime agent (CONTEXT.md "Agent Harness"). The Catalog writes a fresh runtime
// HARNESS.md from these — the create-time counterpart to the per-binding
// `updateBindings` write. `bindings`/`config` default to empty when omitted.
export type CreateAgentInput = {
  agentId: string;
  backend: AgentBackend;
  domain: string;
  promptBody: string;
  bindings?: Partial<HarnessManifest["bindings"]>;
  config?: HarnessManifest["config"];
};

export type Catalog = {
  list(): readonly Agent[];
  get(agentId: string): Agent | undefined;
  // Create a brand-new runtime Agent (the Agent-Manager `create_agent`
  // lifecycle op). Writes a fresh runtime HARNESS.md, emits `agent.created`.
  // Rejects when an agent with this id already resolves (no clobber).
  createAgent(input: CreateAgentInput): Promise<Agent>;
  // Destroy a runtime Agent (the Agent-Manager `destroy_agent` lifecycle op):
  // delete its runtime fork file. Emits `agent.destroyed`. Rejects when no
  // runtime fork exists (a bundled kernel agent cannot be destroyed).
  destroyAgent(agentId: string): Promise<void>;
  // Apply a batch of binding mutations all-or-nothing. Writes/forks to the
  // runtime tier with a single file write, emits one `harness.updated` event.
  // Bundled HARNESS.md is never modified. Empty array is rejected.
  updateBindings(
    agentId: string,
    patches: BindingPatch[],
    source?: "ui" | "agent-manager",
  ): Promise<Agent>;
  // Delete the runtime fork file. Re-resolves to bundled. Emits
  // `harness.updated` with `diff: { kind: "reset" }`.
  resetToBundled(agentId: string): Promise<Agent>;
  // Performs the initial scan. Caller wires audit subscribers first.
  start(): Promise<void>;
  rescan(): Promise<void>;
  events: TypedEmitter<CatalogEvents>;
  dispose(): void;
};
