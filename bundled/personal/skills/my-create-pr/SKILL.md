---
name: my-create-pr
description: Create a pull request with detailed description
tags: [git, workflow]
manualInvocationOnly: true
allowedTools: ["Bash(git:*)", "Bash(gh:*)"]
---

Create a pull request:

1. Check git status and current branch
2. Run git log to see all commits in this branch since diverging from main
3. Run git diff main...HEAD to see all changes
4. Analyze ALL commits and changes (not just the latest)
5. Push to remote if needed (with -u flag for new branches)
6. Create PR using gh pr create with:
   - Clear title summarizing the change
   - Summary section (2-4 bullet points covering all changes)
   - Test plan section
   - Footer: "Generated with [Claude Code](https://claude.com/claude-code)"

Return the PR URL when done.
