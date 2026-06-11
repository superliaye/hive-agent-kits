// `load_skill` (N3) — the body-on-demand half of Skill progressive disclosure
// (CONTEXT.md: one-line descriptions surfaced at Run start, full body pulled
// only when the model calls this). This is the tool that fixes the original
// "agent has no skills" bug.
//
// Command-less, so the permission gate allows it unconditionally (skill loading
// is not a guardrailed action). It is scoped to the Agent's BOUND skills: the
// handler resolves only names in `ctx.boundSkills` through the SkillResolverPort
// — resolving an arbitrary registry skill would bypass spawn-time binding
// (CONTEXT.md: bindings frozen into the Harness). An unknown/unbound name is an
// `isError` result, never a throw (mirrors the F2 `missing` discipline).
//
// On a successful load the handler emits a `run.skill_loaded` audit event
// (skill NAME only — the body is never in the payload, ADR-0004 redaction),
// audit-first: the emit is awaited before the body is returned to the model.

import type { ToolDef } from "../../model-gateway/types.ts";
import type { SkillResolverPort } from "../effect/ports.ts";
import type { ToolContext, ToolHandler, ToolResult } from "./registry.ts";

const LOAD_SKILL_DEF: ToolDef = {
  name: "load_skill",
  description: "Load the full body of one of your available skills by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The name of the skill to load." },
    },
    required: ["name"],
  },
};

function parseInput(input: unknown): { name: string } | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.name !== "string" || rec.name.length === 0) return null;
  return { name: rec.name };
}

// `onLoaded` is the audit-first hook the executor wires to emit
// `run.skill_loaded` (it owns the run/agent ids and the events emitter). The
// handler awaits it BEFORE returning the body, preserving audit-first ordering.
export function makeLoadSkillTool(
  skills: SkillResolverPort,
  onLoaded: (ctx: ToolContext, skillName: string) => Promise<void>,
): ToolHandler {
  return {
    def: LOAD_SKILL_DEF,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseInput(input);
      if (!parsed) {
        return { content: "load_skill: invalid input — expected { name: string }", isError: true };
      }
      const loaded = skills.load(ctx.boundSkills, parsed.name);
      if (!loaded) {
        return {
          content: `load_skill: skill not available: ${parsed.name}`,
          isError: true,
        };
      }
      await onLoaded(ctx, parsed.name);
      return { content: loaded.body, isError: false };
    },
    // Command-less; no sensitive projection (the skill name is surfaced through
    // the dedicated run.skill_loaded event, not the generic tool_use payload).
    describe() {
      return {};
    },
  };
}
