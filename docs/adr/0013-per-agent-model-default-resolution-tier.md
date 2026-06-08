# Per-agent model default: a deployment-stored resolution tier, not the Harness

## What this ADR records

Where a user's chosen model for an Agent's conversations is stored, and where it sits in the Run executor's model resolution. The model the executor sends for a Run resolves through, in order: (1) a per-Run `modelOverride`, (2) the user's per-agent model default (this ADR), (3) the Agent Harness's authored `config.model`, (4) the deployment fallback `MODEL_FALLBACK` (`src/runs/defaults.ts`). Tiers (1), (3), (4) predate this ADR; it adds (2) and fixes where it lives.

## Context

The Settings UI lets a user pick a model when chatting with an Agent. The pick must (a) run the current message on that model and (b) persist as the Agent's default so the next message uses it without re-picking. Three plausible homes for the persisted default, two rejected:

- **The Agent Harness (`config.model`).** Rejected. The Harness is a bundled, version-controlled artifact (`bundled/agents/*/HARNESS.md`); a user's pick written there would be clobbered on the next ship/update, and it conflates *authored* agent design with *user* preference. CONTEXT.md already states per-Run UI overrides never persist to the Harness — extending that to a sticky default must not change it.
- **The Config module (`~/.hive/config.yaml`).** Rejected. Config is a single deployment-wide *closed* Zod schema typed by domain (ADR-0006), read by every component. An open-ended `agentId → model` map is per-Agent state, not deployment-wide settings, and does not fit a closed schema. CONTEXT.md's boundary rule: Agent-specific things stay with the Agent, not in Config.
- **A dedicated per-agent preference store.** Chosen.

## Decision

Add a small, dedicated **agent model-preferences** store (`src/agent-prefs/`), persisted at the deployment (`~/.hive/agent-model-prefs.json`), keyed `agentId → { model, updatedAt }`. It is Effect-native (`AgentModelPrefsLive`, ADR-0011), mirrors the Secrets store shape, and exposes a read-only narrow port (`AgentModelPrefsPort.get(agentId)`) to the Run executor.

Resolution becomes four-tier: `modelOverride ?? userAgentDefault ?? harness.config.model ?? MODEL_FALLBACK`. The executor is a pure *reader* of the preference; the *write* is an explicit `PUT /api/agents/:id/model-pref` the UI calls when the user changes the picker (the same model also rides the in-flight Run as `modelOverride`, so the choice takes effect immediately, even before the write lands). Setting a default is user-driven state, so the store emits a typed event that Audit subscribes to (`agent-prefs` source, ADR-0004) — the model id is non-secret and rides the payload.

The picker's options come from `GET /api/models`, the intersection of configured providers (Secrets) and routable providers (the gateway's adapter allowlist), enumerated through the gateway seam so pi-ai stays imported only in its adapter (ADR-0005).

## Consequences

- A user's model choice survives Harness updates and daemon restarts, and is not entangled with bundled agent design or deployment Config.
- The Harness's `config.model` stays the *authored* default; the new tier is the *user* default layered above it. The two are deliberately distinct.
- v1 has no "clear the default" contract — the picker always sends a concrete model. Reverting to the Harness default means re-picking it (or adding a delete verb if the need arises).
- Reversal cost is moderate: the store, the port, the four-tier line in the executor, and the two routes. Recorded here because "why a fourth tier and a separate file, not Config or the Harness" is non-obvious without it.
