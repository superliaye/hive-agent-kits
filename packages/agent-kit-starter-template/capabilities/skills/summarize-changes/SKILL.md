---
name: summarize-changes
description: Summarize the working-tree changes into a concise, reviewable digest. Use when the user wants an overview of what changed before committing or opening a PR.
---

# Summarize Changes

An offline-safe Starter skill demonstrating the `skill` capability kind — an
on-demand technique folder copied into a CLI's skills location.

## Steps

1. Read the diff (`git diff` and `git diff --staged`).
2. Group changes by intent (feature, fix, refactor, docs, test).
3. Produce a short digest: one line per group, files touched, and the net effect.
4. Flag anything risky or surprising for the reviewer.
