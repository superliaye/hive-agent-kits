---
name: my-clean-code
description: Clean up code and docs - remove unused, fix style, improve quality
tags: [code-quality, refactoring]
manualInvocationOnly: true
allowedTools: ["Read", "Edit", "Grep", "Bash(npm:*)", "Bash(rushx:*)"]
---

Clean up code and documentation:

## Code Cleanup
1. Remove unused imports, variables, functions
2. Fix style violations and type issues
3. Remove commented-out code (git remembers)
4. Remove/rephrase personal developer comments not meant for production:
   - "I removed this for compatibility"
   - "TODO: ask John about this"
   - "This is a hack, will fix later"
   - Decision history ("tried X but Y worked better")
5. Ask before major refactoring

## Documentation & Comments Cleanup
Apply "evergreen" principle - docs describe CURRENT state, not their own history.

**Remove:**
- Version numbers, "Last Updated" dates in docs
- Change history within docs (CHANGELOG files are fine)
- Migration notes ("moved from...", "previously in...")
- Breadcrumbs to old locations
- Appended updates ("Update: now we also...")

**Rewrite, don't append** - update sections in place with current truth. Git tracks history, docs should be timeless.

## After Changes
1. Run build/lint to verify
2. Summarize what was cleaned

Focus on safe, obvious improvements.
