---
description: Core repo-agnostic conduct rules — evergreen docs, ask before git mutations, research current-state claims
applyTo: "**"
added_in: 0.1.0
---

# Core Instructions

## Rules

- Delete commented-out code and personal dev notes
  - Remove: `// TODO: ask John`, `// hack, fix later`, `// I removed this for compatibility`

- Docs describe current state, not history. Rewrite, don't append.
  - Remove: "Last Updated: Jan 2025", "moved from old-file.md", "Update: we now also support..."

- Verify current-state claims about runtime behavior against live source, never from memory or a prior artifact.
  - A doc/help claim about what a command writes or reads (e.g. "update writes .agent-kit.yaml", "runUpdate honors --bundles") must be confirmed against the file:line in THIS tree before you assert it.
  - Do NOT carry a "verified" fact forward from an earlier run summary, status.md, or scratch note — re-check at HEAD.

- Git mutations (add/commit/push) need confirmation. Read-only (status/diff/log) are safe.
  - Ask before: `git commit -m "..."` -> Do without asking: `git diff`

- No excessive praise. Direct and objective.
  - Avoid: "Great question!" -> Prefer: "Here's how to fix it."

## Research current-state claims

Don't answer "how are people doing X these days" / "what's the recommended Y" / "is Z still maintained" from training. Tool ecosystems move; training data is stale.

- Trigger: current community practice, recent versions, library status, "what's recommended now", "have people moved past..."
- Action: WebSearch + WebFetch official docs + recent (≤12mo) sources, or spawn a research agent. Label what came from where ("docs say X" vs "community thread reports Y"). Cite URLs.
- Skip: stable knowledge — language semantics, algorithms, OS internals, math.

If asked a current-state question and you answered from training, say so up front. Don't hide it.

## Suggesting New Rules

If you notice patterns worth adding: mention it. High bar: must prevent recurring mistakes, not be obvious, apply broadly.