// Deployment-level defaults for the Run executor.
//
// `MODEL_FALLBACK` is the model used when nothing earlier in the resolution
// chain specifies one. Picked for cost + Anthropic-first per CLAUDE.md
// guidance — Anthropic Claude Haiku 4.5 is the cheapest real model that
// supports tool use + thinking, suitable as the universal fallback.
//
// Model resolution is four-tier (ADR-0013): (1) per-Run override,
// (2) the user's per-agent model default, (3) Harness `config.model`,
// (4) this fallback. The Run executor consults all four.
//
// Thinking-effort resolution mirrors the first three tiers (ADR-0013):
// (1) per-Run effort override, (2) the user's per-agent effort default,
// (3) Harness `config.thinkingEffort`. There is NO effort fallback — when all
// three are absent the executor sends no `thinking` block and the provider
// applies its own default.

export const MODEL_FALLBACK = "anthropic/claude-haiku-4-5";
