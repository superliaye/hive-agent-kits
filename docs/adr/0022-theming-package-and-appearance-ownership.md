# 22. `@hive/theming` package and appearance-schema ownership

## Status
Accepted

## Context
The theming module lived inside the UI (`packages/ui/src/theming`). The appearance
wire shape was defined twice: the daemon owned an `AppearanceConfigSchema` (Zod, in
`config/schema.ts`) for the `/api/appearance` boundary, and the UI's `serialize.ts`
hand-rolled the same bounds (8..48, 0..100, 1..64, 1..256) for share-with-friends
import. A cross-package `appearance-shape-drift` test reached from the daemon into the
UI's theming types to assert the two stayed in lock-step. That seam — a daemon test
importing UI source, plus two independent validators for one shape — was interim
scaffolding noted in ADR-0020, not a durable design.

## Decision
Two hard-to-reverse moves:

1. **A new `@hive/theming` workspace member**, beyond the four `packages/*` named in
   ADR-0020 (`daemon`, `ui`, `shell`, `contract`). The portable theming module
   (already zero-coupled to Hive — it imports only React + its own siblings) is
   promoted to its own package so both the UI and the daemon can depend on it. It
   exposes two entry points: `"."` (the React barrel) and `"./schema"` (a React-free
   subpath holding only the Zod appearance schema + inferred types + defaults).

2. **The appearance schema's ownership flips.** `@hive/theming/schema` is now the
   single source of truth for `AppearanceConfigSchema`/`ThemeConfigSchema` and
   `APPEARANCE_DEFAULTS`. The **daemon consumes** it (`config/schema.ts`,
   `server/routes.ts` import from `@hive/theming/schema`) — the reverse of ADR-0020's
   interim seam where the daemon owned the schema and the drift test reached into the
   UI. The UI validates imports against the same schema. Both the hand-coded bounds in
   the UI and the `appearance-shape-drift` test are deleted.

The daemon's `.strict()` parse still governs both directions of `/api/appearance`
(PUT body + the stored-config GET response). The UI's share-with-friends import uses a
**key-stripping (lenient)** parse of the same shape — preserving the prior forward-compat
behavior of silently dropping unknown keys — never the strict daemon variant.

## Consequences

- One appearance definition, owned by theming; both sides validate identically. The
  bounds live once.
- **The dependency direction is now daemon → theming.** Acceptable: theming stays
  dependency-light (`zod` only, with a `react` peer). The daemon imports **only** the
  React-free `@hive/theming/schema` subpath, never the bare `@hive/theming` barrel
  (which pulls React). A standing Biome `noRestrictedImports` rule scoped to
  `packages/daemon/src/**` (in `biome.json`) fails the lint gate on any bare-barrel
  import from daemon source, so this holds on every check, not just at build time. It
  is a guard, not a structural wall; if the subpath proves leaky it splits into
  `@hive/theming-schema` + `@hive/theming`.
- The hard constraint from ADR-0020 holds: the UI's Vite renderer bundle can import
  `@hive/theming` without pulling any daemon-only dep (Effect, Hono, vendor SDKs)
  through it, because theming depends on nothing but `zod` + `react`.
- ADR-0020's description of the interim appearance seam (the daemon owning appearance,
  a drift test reaching into UI theming) is now false and has been corrected there;
  this ADR supersedes the appearance half of that seam.
