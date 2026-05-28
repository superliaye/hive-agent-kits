# C4 diagrams

[C4 model](https://c4model.com) views of Hive at three zoom levels. Source of truth for the system shape; complements [CONTEXT.md](../../CONTEXT.md) (vocabulary) and [docs/adr/](../adr/) (decisions).

| Level | File | Scope |
|---|---|---|
| C1 — System Context | [c1-system-context.md](c1-system-context.md) | Hive as one box. Users and external systems. |
| C2 — Containers | [c2-containers.md](c2-containers.md) | Processes and stores inside Hive: Shell, UI, Daemon, the `~/.hive/` files. |
| C3 — Daemon Components | [c3-daemon-components.md](c3-daemon-components.md) | Modules inside the Daemon: Server, Runs, ModelGateway, Audit, Catalog, Registry, Threads, Secrets, Config. |
| C3 — UI Components | [c3-ui-components.md](c3-ui-components.md) | React surfaces: pages, components, hooks, the daemon API client. |

The Shell container is small enough (`shell/src/main.ts`, `shell/src/preload.ts`) that a dedicated C3 would just restate the file list — read those files directly.

## Vocabulary

Terms in the diagrams (Agent, Run, Capability, ModelGateway, Audit Log, etc.) are defined in [CONTEXT.md](../../CONTEXT.md). Diagrams use those terms exactly.

## Viewing

The diagrams are Mermaid blocks inside Markdown.

- **GitHub** — renders Mermaid in `.md` natively.
- **VS Code** — install `bierner.markdown-mermaid`, then open the file and press `Ctrl+Shift+V`.
- **Browser** — paste a single block into [mermaid.live](https://mermaid.live) for an interactive view + PNG/SVG export.

## Keeping them current

The diagrams describe current state. When a structural change lands (new module under `src/`, new container, new external system), update the affected level in the same PR. Don't append a changelog — rewrite.
