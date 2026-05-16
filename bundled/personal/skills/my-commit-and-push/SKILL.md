---
name: my-commit-and-push
description: Create a detailed git commit and push to remote
tags: [git, workflow]
manualInvocationOnly: true
allowedTools: ["Bash(git:*)"]
---

Create a git commit and push, following best practices:

1. Run git status and git diff to see changes
2. Analyze all changes (not just latest)
3. Create a consise one line commit message about the change
4. After successful commit, push to the remote tracking branch
5. (optional) If this is the first push of the branch, follow these rules to generate a PR description:
```
## Audience
The primary audience is human code reviewers. They can read the diff — don't repeat what's obvious from the code.

## Structure
Split into two parts:

1. **Main description** (for humans): Concise. Cover:
   - **Problem**: What's the symptom the user sees or the system exhibits?
   - **Root cause**: Why does it happen?
   - **Fix**: What does this change do about it? Only reference specific code when needed for context a reviewer can't get from the diff alone.

2. **Appendix** (collapsed `<details>`): For agents, future archaeology, or deeper context. Can include file lists, behavior matrices, build status, edge cases.

## Style
- Be direct and brief. Assume the reader is an experienced engineer.
- Do not pad with filler, caveats, or over-explanation.
- Do not list every file changed or describe every line — that's what the diff is for.

## Format
Wrap the entire output in a fenced code block (```) so the user can copy raw markdown without the chat interface rendering it.
```
