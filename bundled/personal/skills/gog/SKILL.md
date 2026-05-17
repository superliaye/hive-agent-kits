---
name: gog
description: >-
  Personal CLI invoked via the `run_shell` Tool. Use when the user asks the
  agent to operate on their personal library through the `gog` command —
  search, list, fetch. Returns structured `{stdout, stderr, exitCode}`.
tags: [cli, personal, search]
compatibility:
  system:
    binaries: [gog]
    platforms: [win32, darwin, linux]
allowedTools:
  - "Bash(gog:*)"
argumentHint: "<subcommand> [args...]"
---

# `gog` — personal CLI

`gog` is a personal command-line tool. Invoke it through the `run_shell`
built-in Tool. The Capability Compatibility validator confirms the binary
is on `$PATH` at Run start; if it's absent, the Run refuses before any
execution happens — no silent under-delivery.

## Invocation shape

```
run_shell({
  command: "gog",
  args: ["search", "<query>"]
})
```

The daemon executes the command and returns `{stdout, stderr, exitCode}`.
Treat exit-code-0 as success; non-zero is an error and the message will be
in `stderr`.

## Worked example

User asks: *"Search my library for the query 'xyz'"*.

```
run_shell({command: "gog", args: ["search", "xyz"]})
→ stdout: <result list>
  stderr: ""
  exitCode: 0
```

Parse `stdout` line-by-line; surface to the user.

## When to use this skill

- The user explicitly mentions `gog`, "my library", or a personal-library
  search/list/fetch verb.
- The user asks for content that's known to live in their personal library.

## When NOT to use this skill

- A general web search — that's a different Tool / MCP server.
- A file-system search — use `Bash(grep)` or similar.
- The user's query is unrelated to their personal library.

## Notes

- This Skill is **not bound** to Root or Agent Manager by default. A future
  personal Worker Agent will bind it when its domain warrants.
- Permission System (G2 in ADR-0003) will read `allowedTools` to scope the
  `run_shell` allowlist when the agent has this Skill bound — restricting
  shell access to `gog` subcommands only during this skill's execution.
- If `gog` is unavailable on the user's machine, the Run start validator
  surfaces the missing-binary error; no execution attempt is made.
