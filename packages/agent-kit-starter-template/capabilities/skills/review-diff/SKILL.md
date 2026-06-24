---
name: review-diff
description: Review the current diff for correctness, robustness, and clarity, returning findings grouped by severity. Use when the user wants a focused code review of an in-progress change.
---

# Review Diff

An offline-safe Starter skill demonstrating a second `skill` capability — a
focused, dependency-free code-review technique.

## Steps

1. Read the diff against the base.
2. For each hunk, check correctness, error handling, and edge cases.
3. Note reuse and simplification opportunities separately from bugs.
4. Return findings grouped: blocking, should-fix, nice-to-have.
