# LLM transport: pi-ai retained; @effect/ai deferred

## What this ADR records

That Hive's LLM transport stays on **pi-ai** (`@earendil-works/pi-ai`), wrapped in Effect at the model-gateway adapter, and that **`@effect/ai`** is deferred — even though Effect-TS is the default substrate for daemon source (see [AGENTS.md](../../AGENTS.md) "Architecture defaults"). The Gateway seam itself is in [ADR-0005](0005-model-gateway-design.md); this ADR records only the transport-library choice behind that seam.

## Context

Adopting Effect everywhere raises an obvious question at the LLM boundary: use `@effect/ai` (and `@effect/ai-anthropic`) so the transport is Effect-native end to end, rather than wrapping a plain-async library.

The bet rides the `effect` core itself, not the AI package. The two are separable: the typed-error channel and `Layer`/`Context` DI we depend on come from `effect` (the substrate adopted in [ADR-0011](0011-effect-ts-daemon-substrate.md)), not from `@effect/ai`. So the version posture for the core (currently v4 beta) and the decision to defer `@effect/ai` are independent calls — the latter rests on a functional gap, below, not on relative maturity.

## Decision

Keep pi-ai as the transport; wrap it in Effect at the `src/model-gateway/` adapter. Defer `@effect/ai`.

Drivers:

- **Auth.** `@effect/ai-anthropic` has no OAuth / token-refresh / Claude Pro-Max subscription auth, and no roadmap for one. pi-ai provides that first-class — including the mid-stream OAuth refresh the Gateway relies on (`getOAuthApiKey`, `onRefresh`; see [ADR-0005](0005-model-gateway-design.md)). This alone is disqualifying for `@effect/ai-anthropic` today.
- **Maturity is not the deciding factor, the auth gap is.** `@effect/ai` being early would not by itself disqualify it here (this repo runs the `effect` core on beta deliberately — [ADR-0011](0011-effect-ts-daemon-substrate.md)). The transport stays on pi-ai because of the auth gap above, which no maturity timeline closes.
- **The wrap is cheap and already the rule.** "Plain async only at I/O edges" means the transport was always going to be an Effect-wrapped adapter. pi-ai sits exactly there — `Effect.tryPromise` / `Stream.fromAsyncIterable` inward — so using it costs nothing against the substrate decision.

## Consequences

- The Gateway adapter is the one sanctioned plain-async boundary for completions; everything inward of it is Effect.
- Hive owns the semantic error taxonomy (`GatewayErrorCode`) at the port; the pi-ai edge maps into it. Effect gives the channel, not the meaning.
- Revisit when `@effect/ai-anthropic` ships subscription/OAuth auth with mid-stream refresh. The Gateway's deep-module shape (one verb, narrow interface) means swapping the transport is contained to `src/model-gateway/adapters/` and `registry.ts` — adding or replacing an adapter requires no changes outside the module ([ADR-0005](0005-model-gateway-design.md), validation criteria).
