# C1 — System Context

Hive as a single system, the user it serves, and the external systems it depends on. Vocabulary per [CONTEXT.md](../../CONTEXT.md).

```mermaid
C4Context
    title System Context — Hive

    Person(user, "User", "Single user. Carries Personal-origin Capabilities across companies; gains Workplace-origin Capabilities at each employer.")

    System(hive, "Hive", "Portable personal AI system. Daemon + Shell hosting the Agent Catalog, Runs, per-Agent Memory, Capability Registry, and Audit Log.")

    System_Ext(llm, "LLM Providers", "Anthropic, OpenAI, Gemini, Bedrock, Ollama, ... Reached via ModelGateway + Provider Adapter. Used by native-backend Runs.")

    System_Ext(mcp, "MCP Servers", "External processes exposing Tools and resources via the Model Context Protocol. Personal-origin (local) or Workplace-origin (company).")

    System_Ext(cli, "External Agent CLIs", "claude-code, codex, ... Today wired as a ModelGateway provider adapter (claude-cli); future CLI-driven Agent Backends bypass the gateway entirely.")

    System_Ext(shell, "Local Shell / OS", "Invoked via the built-in run_shell Tool against a per-Agent command allowlist (gog, gh, docker, az, ...).")

    Rel(user, hive, "Chats with Agents; edits Configuration; approves Permissions", "Electron Shell or HTTP+WS on localhost")
    Rel(hive, llm, "Completion calls (native backend only)", "HTTPS")
    Rel(hive, mcp, "Tool calls; resource reads", "MCP over stdio or HTTP")
    Rel(hive, cli, "Spawns subprocess; streams stdout as RunEvents / GatewayEvents", "stdio")
    Rel(hive, shell, "Executes allowlisted commands", "subprocess")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Notes

- **One actor.** Hive is single-user. Multi-Agent dispatch (Root → Worker) is internal, not a context-level relationship.
- **Headless Mode** is the same Daemon binary without the Shell — an operating mode of the same system, not its own context box.
- **External Agent CLIs and LLM Providers are separate** because [ADR-0005](../adr/0005-model-gateway-design.md) splits the gateway and [CONTEXT.md](../../CONTEXT.md#L110) describes the future seam where CLI-driven Agent Backends bypass the gateway entirely.
- **`run_shell` / Local Shell** is shown as external because the per-Agent command allowlist is a real trust boundary.
