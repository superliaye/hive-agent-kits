# Selection resolution: per-conversation scope, apply-to-default promotion, symbolic defaults, and backend as a user axis

---
status: Superseded by ADR-0021
supersedes: parts of ADR-0013
---

## What this records

How a user's choice of **model**, **thinking effort**, and **Agent Backend** for an Agent resolves at Run start, and where each choice is stored. Evolves [ADR-0013](0013-per-agent-model-default-resolution-tier.md), which established per-agent model/effort defaults as a deployment-stored tier but made two narrower decisions we are now reversing.

## Decision

The three user-selectable axes (model, effort, **Agent Backend**) resolve through the same scopes, in order:

1. **Conversation scope** — a pick applies to *this Thread* and sticks for its later Runs.
2. **Agent default** — the per-Agent default, deployment-stored, set initially by the **Agent Manager**.
3. **Harness-authored default**, then deployment fallback.

Two mechanics layer on top:

- **Apply-to-default promotion.** A UI pick applies to the conversation only; an explicit *apply-to-default* action promotes it to the Agent default. This **supersedes ADR-0013's** "a pick both runs the message and persists as the default" — use-here and make-default are now separate acts. The affordance surfaces inline when the conversation's pick differs from the Agent default.
- **Symbolic defaults.** A default may be a *rule* ("latest model", "highest effort") resolved at Run start, not a pinned id. This **supersedes ADR-0013's** "v1 has no symbolic values; the picker always sends a concrete value." "Highest effort" resolves against the chosen model's supported levels (already computed per-model). "Latest model" requires a **recency/preference ordering in the model catalog** that does not exist today — a new daemon-side resolver, not a UI nicety.

**Backend joins the axes for Worker Agents only.** The Root Agent and Agent Manager stay `native` (their dispatch/lifecycle Tools are in-process built-ins a CLI cannot invoke). Unlike the scalar axes, a backend choice carries **no stored config block** — a CLI backend's invocation is *assembled* at Run start ([ADR-0016](0016-cli-backend-projecting-spawn.md)), so the axis stays a simple discriminator and a native-authored agent can be run under a CLI without the Agent Manager pre-authoring CLI config. **[Superseded in part by [ADR-0018](0018-relax-worker-only-backend-gate.md):** the gate is relaxed to **every Agent except the Agent Manager** — the Root Agent may now pick a CLI backend; only the Agent Manager stays native-locked.**]**

**Stored conversation-scope values are open strings; the resolver is the single concretization point and fails soft.** The per-Thread `model_pref` / `effort_pref` columns hold a raw `string | null` — a concrete `provider/model` or effort level, a symbolic token (`"latest"` / `"highest"`), or `null` (unset). They are **deliberately not narrowed** at the storage boundary (no Zod tighten in the store, no `ModelDefault | EffortDefault` patch type). A stored value carries no implicit guarantee it is still routable: the catalog moves, a credential is removed, a symbolic token must be re-resolved every Run. The **single place** an open string becomes a concrete model + effort is the Run-start resolver (`runs/resolve.ts`), so there is exactly one tier policy and one set of failure semantics to reason about. The resolver **fails soft** where soft failure is meaningful: a malformed/unrecognized effort narrows to `undefined` (no `thinking` block — the no-effort-fallback invariant), and a symbolic model with nothing runnable to resolve to surfaces a typed `model_not_found` (an actionable "no credentialed provider" error, not a silent wrong-model run). A truly malformed stored *model* string still surfaces a typed `invalid_request` at the resolver — the concretization point, never the store, owns that classification.

## Why

The frozen-Harness philosophy kept backend Harness-declared and made every pick a sticky default. Real use wants to try a model/effort/backend *for one conversation* without disturbing the agent's default, and wants the Agent Manager to author "use the latest/highest" without pinning a version that ages. Defaults remain deployment-stored (never written back to the Harness), so authored agent design is still never clobbered.
