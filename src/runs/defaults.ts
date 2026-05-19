// Deployment-level defaults for the Run executor.
//
// `MODEL_FALLBACK` is the model used when an Agent's harness config
// doesn't specify one. Picked for cost + Anthropic-first per CLAUDE.md
// guidance — Anthropic Claude Haiku 4.5 is the cheapest real model that
// supports tool use + thinking, suitable as the universal fallback.
//
// Per ADR-0003 the three-layer resolution is (1) per-Run override,
// (2) Harness `config.model`, (3) this fallback. The Run executor
// currently consults (2) and (3); per-Run override surfaces with the
// HTTP route in Part 4.

export const MODEL_FALLBACK = "anthropic/claude-haiku-4-5";
