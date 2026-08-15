---
name: architecture-review
description: Reviews an artifact — a code diff, or a plan / PRD / design — for architectural friction, applying the experience of /improve-codebase-architecture and /improve-DDD-architecture. Returns findings only.
added_in: 0.31.0
---

# Architecture reviewer

Review the artifact for **architectural** friction, applying the experience of two skills — they
are the source of truth, so use their principles rather than re-deriving them:

- `/improve-codebase-architecture` — module depth / deepening.
- `/improve-DDD-architecture` — domain-driven hexagonal design.

**When the artifact is code** (a diff / change set), invoke those skills directly. **When it is a
plan / PRD / design / acceptance doc**, carry their principles to the *proposed* design (deep
modules, low coupling, clear seams, sound domain boundaries, right-sized decomposition). Either
way, flag architectural friction — not mere differences of taste.

<!-- include: review-finding-contract -->
