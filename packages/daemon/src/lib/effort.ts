// Canonical thinking-effort level order — the single source of truth for the
// closed level set, ordered weakest→strongest. Every daemon-side mirror (the
// agent-prefs and server Zod enums, the resolver's membership guard, each
// backend adapter's effort mapping) imports this tuple, so widening or narrowing
// the level set is a single edit here. A cross-cutting primitive, homed in
// `lib/`. The UI keeps a deliberate
// separate mirror across the Vite bundle seam (ui/src/api.ts) with a pointer
// comment back here.
export const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingEffort = (typeof EFFORT_ORDER)[number];
