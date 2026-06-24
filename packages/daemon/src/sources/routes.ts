// Sources HTTP routes (ADR-0023). Mounted additively behind the surviving
// server. Zod at the boundary; typed errors mapped to wire codes. Mirrors
// `kit/routes.ts`.

import { AddSourceBody } from "@hive/contract";
import type { Effect } from "effect";
import { Hono } from "hono";
import { ZodError } from "zod";
import { DuplicateOrigin, SourceIoError, SourceNotFound } from "./effect/errors.ts";
import type { SourceRegistrySvc } from "./effect/sources-live.ts";

// Discharge a Sources Effect off the root runtime. Returns a Promise<Either>-like.
export type RunSources = <A, E>(
  effect: Effect.Effect<A, E>,
) => Promise<{ ok: true; value: A } | { ok: false; error: E }>;

function zodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export function buildSourcesRoutes(registry: SourceRegistrySvc, run: RunSources): Hono {
  const app = new Hono();

  app.get("/api/sources", async (c) => {
    const res = await run(registry.list());
    if (res.ok) return c.json(res.value);
    return c.json({ error: "list failed", message: res.error.message }, 500);
  });

  app.post("/api/sources", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = AddSourceBody.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "invalid source", issues: zodIssues(parsed.error) }, 400);
    }
    const res = await run(registry.add(parsed.data.origin));
    if (res.ok) return c.json(res.value, 201);
    const err = res.error;
    if (err instanceof DuplicateOrigin) {
      return c.json({ error: "duplicate origin", origin: err.origin }, 409);
    }
    return c.json({ error: "add failed", message: err.message }, 500);
  });

  app.post("/api/sources/:id/activate", async (c) => {
    const res = await run(registry.activate(c.req.param("id")));
    if (res.ok) return c.json(res.value, 200);
    return notFoundOr500(c, res.error, "activate failed");
  });

  app.post("/api/sources/:id/deactivate", async (c) => {
    const res = await run(registry.deactivate(c.req.param("id")));
    if (res.ok) return c.json(res.value, 200);
    return notFoundOr500(c, res.error, "deactivate failed");
  });

  app.delete("/api/sources/:id", async (c) => {
    const res = await run(registry.delete(c.req.param("id")));
    if (res.ok) return c.body(null, 204);
    return notFoundOr500(c, res.error, "delete failed");
  });

  return app;
}

// Map the shared `SourceNotFound | SourceIoError` channel to 404 / 500.
function notFoundOr500(
  c: { json: (v: unknown, status: 404 | 500) => Response },
  err: SourceNotFound | SourceIoError,
  label: string,
): Response {
  if (err instanceof SourceNotFound) {
    return c.json({ error: "source not found", id: err.id }, 404);
  }
  return c.json({ error: label, message: err.message }, 500);
}

async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}
