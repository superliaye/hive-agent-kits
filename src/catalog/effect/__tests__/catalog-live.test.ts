import { describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Catalog, CatalogLive } from "../catalog-live.ts";
import { CatalogAgentNotFound } from "../errors.ts";

describe("CatalogLive — effect surface", () => {
  test("requireAgent fails with typed CatalogAgentNotFound for a missing agent", async () => {
    const rt = ManagedRuntime.make(CatalogLive({ watch: false, logErrors: false }));
    const svc = rt.runSync(Catalog);
    await svc.start();

    const failure = await Effect.runPromise(
      Effect.flip(svc.requireAgent("__definitely_missing__")),
    );
    expect(failure).toBeInstanceOf(CatalogAgentNotFound);
    expect(failure.agentId).toBe("__definitely_missing__");

    // A real bundled agent (when present) resolves through the same verb.
    const first = svc.list()[0];
    if (first) {
      const ok = await Effect.runPromise(svc.requireAgent(first.agentId));
      expect(ok.agentId).toBe(first.agentId);
    }
    rt.dispose();
  });
});
