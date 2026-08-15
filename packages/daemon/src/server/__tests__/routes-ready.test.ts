import { describe, expect, test } from "bun:test";
import { createServer, type ServerHandles } from "../index.ts";

async function dispose(server: ServerHandles): Promise<void> {
  await server.dispose();
  delete process.env.HIVE_PACKAGED;
}

describe("server routes - ready", () => {
  test("reports dev sandbox mode when HIVE_PACKAGED is absent", async () => {
    delete process.env.HIVE_PACKAGED;
    const server = await createServer({ mode: "memory", token: "test-token" });
    try {
      const res = await server.app.fetch(new Request("http://localhost/api/ready"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        protocolVersion: 1,
        buildVersion: server.buildVersion,
        daemonInstanceId: server.daemonInstanceId,
        runtimeRootId: server.runtimeRootId,
        daemonMode: "dev",
        deployTargetMode: "sandbox",
        activeExternalSessions: 0,
      });
    } finally {
      await dispose(server);
    }
  });

  test("reports packaged real-home mode when HIVE_PACKAGED=1", async () => {
    process.env.HIVE_PACKAGED = "1";
    const server = await createServer({ mode: "memory", token: "test-token" });
    try {
      const res = await server.app.fetch(new Request("http://localhost/api/ready"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        protocolVersion: 1,
        buildVersion: server.buildVersion,
        daemonInstanceId: server.daemonInstanceId,
        runtimeRootId: server.runtimeRootId,
        daemonMode: "packaged",
        deployTargetMode: "real",
        activeExternalSessions: 0,
      });
    } finally {
      await dispose(server);
    }
  });

  test("reports dev real-home mode when the developer override is enabled", async () => {
    delete process.env.HIVE_PACKAGED;
    const server = await createServer({ mode: "memory", token: "test-token" });
    try {
      await server.config.set("developer", { allowRealHomeDeploy: true });
      const res = await server.app.fetch(new Request("http://localhost/api/ready"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        protocolVersion: 1,
        buildVersion: server.buildVersion,
        daemonInstanceId: server.daemonInstanceId,
        runtimeRootId: server.runtimeRootId,
        daemonMode: "dev",
        deployTargetMode: "real",
        activeExternalSessions: 0,
      });
    } finally {
      await dispose(server);
    }
  });
});
