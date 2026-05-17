// Daemon executable entrypoint. `bun run src/server/start.ts` (or via the
// "start" npm script) boots the daemon in file mode against ~/.hive/.

import { createServer } from "./index.ts";

async function main(): Promise<void> {
  const server = await createServer({ mode: "file" });
  // HIVE_PORT env var overrides config — used by e2e tests for isolation.
  const port = process.env.HIVE_PORT ? Number(process.env.HIVE_PORT) : server.port;
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: server.app.fetch,
  });
  console.log(
    `[daemon] listening on http://127.0.0.1:${port} | ` +
      `registry=${server.registry.list().length} capabilities, ` +
      `catalog=${server.catalog.list().length} agents`,
  );
}

main().catch((err) => {
  console.error("[daemon] failed to start:", err);
  process.exit(1);
});
