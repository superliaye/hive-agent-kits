// Daemon executable entrypoint. `bun run src/server/start.ts` (or via the
// "start" npm script) boots the daemon in file mode against ~/.hive/.

import { createServer } from "./index.ts";

async function main(): Promise<void> {
  const server = await createServer({ mode: "file" });
  // Bun's serve binds when this module is the entry point.
  Bun.serve({
    port: server.port,
    hostname: "127.0.0.1",
    fetch: server.app.fetch,
  });
  console.log(
    `[daemon] listening on http://127.0.0.1:${server.port} | ` +
      `registry=${server.registry.list().length} capabilities, ` +
      `catalog=${server.catalog.list().length} agents`,
  );
}

main().catch((err) => {
  console.error("[daemon] failed to start:", err);
  process.exit(1);
});
