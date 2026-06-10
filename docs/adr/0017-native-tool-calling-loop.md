# Native backend: the tool-calling loop, built-in tools, and a configurable cap

---
status: proposed
extends: ADR-0009
---

## What this records

The addition that makes a `native`-backend Agent able to *act* and to load Skills. The Run executor ([ADR-0009](0009-run-pipeline-design.md)) currently streams one assistant turn and stops at `done(tool_use)` — tool dispatch was deferred. Consequently a native agent can read a technique and talk but cannot edit a file, run a command, or even load a Skill (`load_skill` is itself a tool). Reference projects confirm the shape: OpenClaw and Hermes both treat tool-loop + built-in tools (especially shell) as the usefulness floor, with Skills and MCP additive.

## Decision

**Add the multi-turn tool-calling loop** to the native executor: model emits `tool_use` → executor dispatches the bound Tool or `load_skill` → result fed back → re-invoke → repeat until no `tool_use` or the cap is hit.

**v1 native tool set:** built-in **Tools** (`read` / `write` / `edit` / `run_shell`) + **`load_skill`** (skill progressive disclosure per CONTEXT — one-line descriptions surfaced at Run start, body pulled on demand, mirroring Hermes' `skills_list` + `skill_view`). Bound **MCP** is deferred to a fast-follow — it is separable (transport + reference-counted server lifecycle) and, unlike native built-ins, not required for baseline usefulness.

**Permission + audit:** tool execution gates on the **Permission System** at the dispatch point; tool calls and skill loads emit audit events ([ADR-0004](0004-audit-log-design.md)).

**Configurable cap with a grace call:** the loop has a max-iteration cap — a **Configuration**-backed deployment default ([ADR-0006](0006-configuration-module-design.md)), per-agent override deferred — and permits one final *grace* turn for the model to summarize before forced termination (the Hermes pattern), rather than running unbounded (OpenClaw relies on stop-hooks with no hard cap).

## Why

The loop is the unavoidable substrate: both *acting* and *skill disclosure* require it, so it is the real unblock behind "the agent says it has no skills." Built-in tools over MCP-first because a native agent brings nothing and must be able to act; a CLI backend brings its own tools and gets this for free. Cap-plus-grace over unbounded for cost and safety, configurable because the right ceiling differs by deployment and task.
