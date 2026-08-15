import { describe, expect, test } from "bun:test";
import { createDaemonRequestHandler } from "./daemon-request.ts";

const connection = {
  kind: "external" as const,
  baseUrl: "http://127.0.0.1:43117",
  token: "session-secret-value",
  displayName: "Arca",
};

describe("authenticated daemon request handler", () => {
  test("reports real HTTP socket disconnect and recovery transitions", async () => {
    const statuses: string[] = [];
    let server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    const port = server.port;
    const handler = createDaemonRequestHandler(
      { ...connection, baseUrl: `http://127.0.0.1:${port}` },
      fetch,
      (status) => statuses.push(status),
    );

    await expect(handler("/api/ready", {})).resolves.toMatchObject({ status: 200 });
    await server.stop(true);
    await expect(handler("/api/ready", {})).rejects.toThrow();
    server = Bun.serve({ port, fetch: () => Response.json({ ok: true }) });
    await expect(handler("/api/ready", {})).resolves.toMatchObject({ status: 200 });

    expect(statuses).toEqual(["connected", "disconnected", "connected"]);
    await server.stop(true);
  });

  test("reports a disconnect when the response body socket aborts", async () => {
    const statuses: string[] = [];
    const handler = createDaemonRequestHandler(
      connection,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("socket aborted while reading body"));
            },
          }),
        ),
      (status) => statuses.push(status),
    );

    await expect(handler("/api/kit/overview", {})).rejects.toThrow("socket aborted");
    expect(statuses).toEqual(["disconnected"]);
  });

  test("attaches authorization in the privileged handler", async () => {
    let request: Request | undefined;
    const handler = createDaemonRequestHandler(connection, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ ok: true }, { status: 202 });
    });

    const result = await handler("/api/kit/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(request?.url).toBe("http://127.0.0.1:43117/api/kit/deploy");
    expect(request?.headers.get("authorization")).toBe("Bearer session-secret-value");
    expect(result).toEqual({ status: 202, statusText: "", body: '{"ok":true}' });
    expect(JSON.stringify(result)).not.toContain(connection.token);
  });

  test("accepts only relative daemon API paths", async () => {
    const handler = createDaemonRequestHandler(connection, fetch);

    await expect(handler("https://attacker.example/api", {})).rejects.toThrow("relative /api");
    await expect(handler("/settings", {})).rejects.toThrow("relative /api");
    await expect(handler("/api/../outside", {})).rejects.toThrow("relative /api");
  });

  test("does not accept renderer-supplied authorization", async () => {
    const handler = createDaemonRequestHandler(connection, fetch);

    await expect(
      handler("/api/kit/state", { headers: { authorization: "Bearer renderer-token" } }),
    ).rejects.toThrow("authorization header");
  });
});
