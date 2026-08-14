// Shared daemon↔UI wire contract: the single source of truth for the kit +
// backend types both sides exchange, replacing the UI hand-mirrors and the
// wire-mirror drift tests (ADR-0020).
//
// Dependency-light — Zod only. The UI bundles it through Vite, so any daemon-only
// dep (Effect, Hono, vendor SDKs) reachable from here would land in the renderer
// bundle. Schemas must not import daemon internals.

export * from "./backend.ts";
export * from "./connection.ts";
export * from "./kit.ts";
export * from "./source.ts";
