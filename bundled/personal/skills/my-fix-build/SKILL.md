---
name: my-fix-build
description: Analyze and fix build/lint errors
tags: [debugging, build]
manualInvocationOnly: true
allowedTools: ["Bash(npm:*)", "Bash(rushx:*)", "Bash(rush:*)", "Read", "Edit", "Grep"]
argumentHint: "[optional: specific package]"
---

Fix build or lint errors:

1. Run the build/lint command to see errors
2. Read the relevant files with errors
3. Fix each issue systematically
4. Verify the fixes work by running build again
5. Summarize what was fixed

Focus on: $ARGUMENTS
