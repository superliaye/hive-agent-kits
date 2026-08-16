// Sources HTTP routes (ADR-0023). Mounted additively behind the surviving
// server. Zod at the boundary; typed errors mapped to wire codes. Mirrors
// `kit/routes.ts`.

import type { AddSourceResult, Source, SourceLocator, SourceSummary } from "@hive/contract";
import { AddSourceBody, ReorderSourceBody } from "@hive/contract";
import type { Effect } from "effect";
import { Hono } from "hono";
import { ZodError } from "zod";
import { log } from "../lib/log.ts";
import { DuplicateOrigin, SourceIoError, SourceNotFound } from "./effect/errors.ts";
import type { SourceRegistrySvc } from "./effect/sources-live.ts";

// Discharge a Sources Effect off the root runtime. Returns a Promise<Either>-like.
export type RunSources = <A, E>(
  effect: Effect.Effect<A, E>,
) => Promise<{ ok: true; value: A } | { ok: false; error: E }>;

// Consumer-owned lifecycle port: the add → sync → validate orchestration
// and the delete-time Mirror cleanup the route needs, with no Kit-service coupling.
// Both verbs are Effect-returning; the server provides the adapter (kit/onboard +
// kit/mirror). `onboard` never fails (it folds sync/validation failures into the
// result); `forgetMirror` is best-effort (an fs fault never
// fails the already-committed delete).
export type SourceLifecycle = {
  prepareLocator(
    locator: Exclude<SourceLocator, { kind: "starter" }>,
  ): Effect.Effect<Exclude<SourceLocator, { kind: "starter" }>, Error>;
  onboard(source: Source): Effect.Effect<AddSourceResult>;
  forgetMirror(sourceId: string): Effect.Effect<void>;
};

function zodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

function sourceSummary(source: Source): SourceSummary {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    active: source.active,
    createdAt: source.createdAt,
    rank: source.rank,
  };
}

export function buildSourcesRoutes(
  registry: SourceRegistrySvc,
  run: RunSources,
  lifecycle: SourceLifecycle,
): Hono {
  const app = new Hono();

  app.get("/api/sources", async (c) => {
    const res = await run(registry.list());
    if (res.ok) return c.json(res.value.map(sourceSummary));
    log().error(
      { module: "sources/routes", route: "list", err: res.error.message },
      "source list failed",
    );
    return c.json({ error: "source_list_failed" }, 500);
  });

  app.post("/api/sources", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = AddSourceBody.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "invalid source", issues: zodIssues(parsed.error) }, 400);
    }
    const prepared = await run(lifecycle.prepareLocator(parsed.data.locator));
    if (!prepared.ok) {
      return c.json(
        {
          error: "invalid source",
          issues: [{ path: "locator.repoRoot", message: "working tree locator is unavailable" }],
        },
        400,
      );
    }
    const res = await run(registry.add({ ...parsed.data, locator: prepared.value }));
    if (!res.ok) {
      const err = res.error;
      if (err instanceof DuplicateOrigin) {
        return c.json(
          {
            error: "duplicate source",
            ...(parsed.data.locator.kind === "git" ? { origin: err.origin } : {}),
          },
          409,
        );
      }
      log().error(
        { module: "sources/routes", route: "add", err: err.message },
        "source add failed",
      );
      return c.json({ error: "source_add_failed" }, 500);
    }
    // The Source is kept. Sequence add → sync → validate at the edge: onboard only
    // syncs+validates the Mirror (never the registry) and never rejects — a sync or
    // validation failure is folded into the 201 body, and even a DEFECT is
    // caught + degraded to a defect-honest body by the server's onboard adapter. So
    // `lifecycle.onboard`'s channel is `never`: `!ok` here can only be a
    // runner-machinery defect (the Effect runtime itself), a genuine server error —
    // trace it and 500, never swallow it as a silent clean 201. (The Source stays
    // added regardless; sync failures never reach this branch.)
    const onboarded = await run(lifecycle.onboard(res.value));
    if (!onboarded.ok) {
      log().error(
        { module: "sources/routes", sourceId: res.value.id, err: String(onboarded.error) },
        "onboard runner defect after add",
      );
      return c.json({ error: "onboard failed", id: res.value.id }, 500);
    }
    return c.json(onboarded.value, 201);
  });

  app.post("/api/sources/:id/activate", async (c) => {
    const res = await run(registry.activate(c.req.param("id")));
    if (res.ok) return c.json(sourceSummary(res.value), 200);
    return notFoundOr500(c, res.error, "activate failed");
  });

  app.post("/api/sources/:id/deactivate", async (c) => {
    const res = await run(registry.deactivate(c.req.param("id")));
    if (res.ok) return c.json(sourceSummary(res.value), 200);
    return notFoundOr500(c, res.error, "deactivate failed");
  });

  app.post("/api/sources/:id/reorder", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = ReorderSourceBody.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "invalid direction", issues: zodIssues(parsed.error) }, 400);
    }
    const res = await run(registry.reorder(c.req.param("id"), parsed.data.direction));
    if (res.ok) return c.json(sourceSummary(res.value), 200);
    return notFoundOr500(c, res.error, "reorder failed");
  });

  app.delete("/api/sources/:id", async (c) => {
    const id = c.req.param("id");
    const res = await run(registry.delete(id));
    if (!res.ok) return notFoundOr500(c, res.error, "delete failed");
    // Registry row gone → remove the on-disk Mirror dir too, best-effort: the
    // delete already succeeded, so a Mirror-cleanup fault never turns the 204 into
    // an error (forgetMirror is best-effort + its error channel is `never`).
    await run(lifecycle.forgetMirror(id));
    return c.body(null, 204);
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
  log().error({ module: "sources/routes", route: label, err: err.message }, label);
  return c.json({ error: label.replaceAll(" ", "_") }, 500);
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
