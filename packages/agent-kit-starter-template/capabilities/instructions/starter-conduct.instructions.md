---
description: Starter conduct rules — evergreen docs, ask before destructive git, verify current-state claims against live source
applyTo: "**"
---

# Starter Conduct

A minimal, offline-safe instruction shipped with Hive's Starter Source. It
demonstrates the `instruction` capability kind — a body of rules concatenated
into a CLI's global instruction file.

## Rules

- Docs describe the current state, not history. Rewrite, don't append.
- Verify current-state claims about runtime behavior against live source, never
  from memory.
- Destructive git operations (reset --hard, force-push) need explicit
  confirmation. Read-only inspection (status, diff, log) is safe.
- Be direct and objective. No filler, no excessive praise.
