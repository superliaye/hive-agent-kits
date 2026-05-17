// Daemon executable entrypoint. `bun run src/server/start.ts` (or via the
// "start" npm script) boots the daemon in file mode against ~/.hive/.

import { createServer } from "./index.ts";

async function main(): Promise<void> {
  // HIVE_PORT env var → explicit createServer({port}) override → Config default.
  // Reading the env here keeps Config-vs-env precedence settled in one place.
  const envPort = process.env.HIVE_PORT ? parsePort(process.env.HIVE_PORT) : undefined;
  const server = await createServer({ mode: "file", port: envPort });
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

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`HIVE_PORT is invalid: ${raw}`);
  }
  return n;
}

main().catch((err) => {
  console.error("[daemon] failed to start:", err);
  process.exit(1);
});
