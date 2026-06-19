# Per-agent model + effort defaults: a deployment-stored resolution tier, not the Harness

status: Superseded by ADR-0021 — model/effort defaults are deleted with the
agent-running stack (parked as deferred #2).

## What this ADR records

Where a user's chosen **model** and **thinking effort** for an Agent's conversations are stored, and where each sits in the Run executor's resolution. Both resolve through the same shape of tiers, in order:

- **Model:** (1) a per-Run `modelOverride`, (2) the user's per-agent model default (this ADR), (3) the Agent Harness's authored `config.model`, (4) the deployment fallback `MODEL_FALLBACK`.
- **Thinking effort:** (1) a per-Run `effortOverride`, (2) the user's per-agent effort default (this ADR), (3) the Harness's authored `config.thinkingEffort`, (4) **no fallback** — when all three are absent the executor sends no `thinking` block and the provider applies its own default.

The model tiers (1), (3), (4) predate this ADR; it adds the per-agent model and effort defaults and fixes where they live.

## Context

The Settings UI lets a user pick a model AND a thinking effort when chatting with an Agent. Each pick must (a) run the current message with that choice and (b) persist as the Agent's default so the next message reuses it without re-picking. The two are independent — picking one must not disturb the other. Three plausible homes for the persisted defaults, two rejected:

- **The Agent Harness (`config.model` / `config.thinkingEffort`).** Rejected. The Harness is a bundled, version-controlled artifact (`bundled/agents/*/HARNESS.md`); a user's pick written there would be clobbered on the next ship/update, and it conflates *authored* agent design with *user* preference. CONTEXT.md already states per-Run UI overrides never persist to the Harness — extending that to sticky defaults must not change it.
- **The Config module (`~/.hive/config.yaml`).** Rejected. Config is a single deployment-wide *closed* Zod schema typed by domain (ADR-0006), read by every component. An open-ended `agentId → {model, effort}` map is per-Agent state, not deployment-wide settings, and does not fit a closed schema. CONTEXT.md's boundary rule: Agent-specific things stay with the Agent, not in Config.
- **A dedicated per-agent preference store.** Chosen.

## Decision

Add a small, dedicated **agent preferences** store (`src/agent-prefs/`), persisted at the deployment (`~/.hive/agent-model-prefs.json`), keyed `agentId → { model?, effort?, updatedAt }`. Both fields are optional and independent: a write merges, so setting the effort never clobbers a stored model and vice versa. It is Effect-native (`AgentModelPrefsLive`, ADR-0011), mirrors the Secrets store shape, and exposes a read-only narrow port (`getModel` / `getEffort`) to the Run executor.

Resolution becomes the tiers above. The executor is a pure *reader* of the preference; the *write* is an explicit `PUT /api/agents/:id/model-pref` the UI calls when the user changes a picker (the same value also rides the in-flight Run as `modelOverride` / `effortOverride`, so the choice takes effect immediately, even before the write lands). Setting a default is user-driven state, so the store emits a typed `agent_pref.set` event that Audit subscribes to (`agent-prefs` source, ADR-0004) carrying only the touched fields — the model id and effort level are non-secret and ride the payload.

**Effort levels are model-specific.** pi-ai declares the valid levels per model (`thinkingLevelMap`); a model supports the subset of `off | minimal | low | medium | high | xhigh` it actually exposes. A level whose map value is `null` is *unsupported* and dropped — including `off`: a model that declares `off: null` cannot disable reasoning, so the catalog omits `off` from its `efforts` rather than offering a no-op. The catalog (`GET /api/models`) surfaces each model's supported `efforts` through the gateway seam (pi-ai stays imported only in its adapter, ADR-0005), and the composer's effort dropdown shows only the selected model's levels — never a flat global list, and hidden entirely when the model's only supported level is `off` (no real reasoning choice to make). When the user switches to a model that doesn't support a stored effort, the UI drops the incompatible level rather than sending it.

The closed level set itself is a single canonical tuple, `EFFORT_ORDER` (`src/model-gateway/types.ts`): the `ThinkingEffort` type and every daemon-side boundary enum (agent-prefs, server, executor) are inferred from it, so widening or narrowing the set is one edit. The UI keeps a deliberate hand-synced mirror across the Vite bundle seam (it imports no daemon source) with a pointer comment back to the canonical tuple.

## Consequences

- A user's model and effort choices survive Harness updates and daemon restarts, and are not entangled with bundled agent design or deployment Config.
- The Harness's `config.model` / `config.thinkingEffort` stay the *authored* defaults; the new tiers are the *user* defaults layered above them.
- Wiring effort through the executor also activated `config.thinkingEffort`, which was previously dead (the executor built its `CompletionInput` without any `thinking`).
- v1 has no "clear the default" contract — the picker always sends a concrete value. Reverting to the Harness default means re-picking it (or adding a delete verb if the need arises).
- Reversal cost is moderate: the store, the two narrow getters, the resolution lines in the executor, and the two routes. Recorded here because "why a separate per-agent file, not Config or the Harness" and "why per-model effort levels" are non-obvious without it.
