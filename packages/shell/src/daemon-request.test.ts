import { describe, expect, test } from "bun:test";
import { createDaemonRequestHandler } from "./daemon-request.ts";

const connection = {
  kind: "external" as const,
  baseUrl: "http://127.0.0.1:43117",
  token: "session-secret-value",
  displayName: "Arca",
};

describe("authenticated daemon request handler", () => {
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
