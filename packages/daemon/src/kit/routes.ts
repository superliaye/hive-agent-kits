// Kit HTTP routes (Plan A6). Mounted additively behind the surviving server.
// Zod at the boundary; typed errors mapped to wire codes.

import { SelectionSchema } from "@hive/contract";
import { Effect } from "effect";
import { Hono } from "hono";
import { ZodError } from "zod";
import { log } from "../lib/log.ts";
import { DeployError } from "./effect/errors.ts";
import type { KitSvc } from "./effect/kit-live.ts";

// Discharge a Kit Effect off the root runtime. Returns a Promise<Either>-like.
export type RunKit = <A, E>(
  effect: Effect.Effect<A, E>,
) => Promise<{ ok: true; value: A } | { ok: false; error: E }>;

function zodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

// One mapping for a DeployError → wire code, shared by diff and deploy so the
// same reason never gets two different statuses across the two routes.
function deployErrorCode(err: DeployError): 422 | 500 {
  switch (err.reason) {
    case "collision":
    case "missing_binary":
      return 422; // client-fixable: bad selection / absent tool
    default:
      return 500; // io / not_redirected: server-side
  }
}

export function buildKitRoutes(kit: KitSvc, runKit: RunKit): Hono {
  const app = new Hono();

  app.get("/api/kit/catalog", (c) => c.json(kit.catalog()));

  app.get("/api/kit/state", (c) => c.json(kit.state()));

  // On-disk self-check (Feature 1/2). Read-only — no audit row, no body.
  app.get("/api/kit/verify", (c) => c.json(kit.verify()));

  // Per-Source sync (#30): one Source's failure never fails the whole run, so the
  // verb itself does not fail — the response is the per-Source SyncRunResult.
  app.post("/api/kit/sync", async (c) => {
    const res = await runKit(kit.sync());
    if (res.ok) return c.json(res.value);
    // sync() has no typed failure channel; a defect here is a 500.
    log().error({ module: "kit/routes", route: "sync", err: String(res.error) }, "sync defect");
    return c.json({ error: "sync failed", message: String(res.error) }, 500);
  });

  app.post("/api/kit/diff", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = SelectionSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "invalid selection", issues: zodIssues(parsed.error) }, 400);
    }
    const res = await runKit(kit.diff(parsed.data));
    if (res.ok) return c.json(res.value);
    const err = res.error as DeployError;
    return c.json(
      { error: "diff failed", reason: err.reason, message: err.message },
      deployErrorCode(err),
    );
  });

  app.post("/api/kit/deploy", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = SelectionSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "invalid selection", issues: zodIssues(parsed.error) }, 400);
    }
    const res = await runKit(kit.deploy(parsed.data));
    if (res.ok) return c.json(res.value);
    const err = res.error;
    // A defect (untyped throw) squashes to a non-DeployError here. Without this it
    // would surface as a 500 with `reason: undefined` and NO trace line — exactly
    // the blind 500 that made this path hard to diagnose. Log it, return clearly.
    if (!(err instanceof DeployError)) {
      log().error({ module: "kit/routes", route: "deploy", err: String(err) }, "deploy defect");
      return c.json({ error: "deploy failed", reason: "io", message: String(err) }, 500);
    }
    return c.json(
      {
        error: "deploy failed",
        reason: err.reason,
        message: err.message,
        ...(err.tool ? { tool: err.tool } : {}),
        ...(err.name ? { name: err.name } : {}),
      },
      deployErrorCode(err),
    );
  });

  return app;
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
