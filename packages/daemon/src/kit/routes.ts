// Kit HTTP routes. Mounted additively behind the surviving server.
// Zod at the boundary; typed errors mapped to wire codes.

import {
  AcceptedDeployRequest,
  SelectionMutation,
  SelectionSchema,
  SelectionSnapshot,
} from "@hive/contract";
import { Effect } from "effect";
import { Hono } from "hono";
import { ZodError } from "zod";
import { log } from "../lib/log.ts";
import {
  DeployInProgressError,
  ImmutableInstallerStagingError,
  PlanStaleError,
} from "./deploy-coordinator.ts";
import { DeployError } from "./effect/errors.ts";
import type { KitSvc } from "./effect/kit-live.ts";
import { DeploymentSnapshotChangedError } from "./overview.ts";
import { SelectionConflictError, SelectionTargetNotApplicableError } from "./selection-store.ts";

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

  app.get("/api/kit/overview", (c) => {
    try {
      return c.json(kit.overview());
    } catch (error) {
      if (error instanceof DeploymentSnapshotChangedError) {
        return c.json({ error: error.code }, 409);
      }
      log().error(
        { module: "kit/routes", route: "overview", err: String(error) },
        "overview snapshot failed",
      );
      return c.json({ error: "overview_unavailable" }, 500);
    }
  });

  app.get("/api/kit/selection", (c) => {
    try {
      return c.json(SelectionSnapshot.parse(kit.selection()));
    } catch (error) {
      log().error(
        { module: "kit/routes", route: "selection.read", err: String(error) },
        "selection read failed",
      );
      return c.json({ error: "selection_unavailable" }, 500);
    }
  });

  app.patch("/api/kit/selection", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = SelectionMutation.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "invalid selection mutation", issues: zodIssues(parsed.error) }, 400);
    }
    try {
      const committed = SelectionSnapshot.parse(await kit.mutateSelection(parsed.data));
      return c.json(committed);
    } catch (error) {
      if (error instanceof SelectionConflictError) {
        return c.json({ error: "selection_conflict", currentRevision: error.currentRevision }, 409);
      }
      if (error instanceof SelectionTargetNotApplicableError) {
        return c.json({ error: error.code }, 400);
      }
      log().error(
        { module: "kit/routes", route: "selection.mutate", err: String(error) },
        "selection mutation failed",
      );
      return c.json({ error: "selection_mutation_failed" }, 500);
    }
  });

  // On-disk self-check. Read-only — no audit row, no body.
  app.get("/api/kit/verify", (c) => c.json(kit.verify()));

  // Per-Source sync: one Source's failure never fails the whole run, so the
  // verb itself does not fail — the response is the per-Source SyncRunResult.
  app.post("/api/kit/sync", async (c) => {
    const res = await runKit(kit.sync());
    if (res.ok) return c.json(res.value);
    // sync() has no typed failure channel; a defect here is a 500.
    log().error({ module: "kit/routes", route: "sync", err: String(res.error) }, "sync defect");
    return c.json({ error: "sync_failed" }, 500);
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
    const status = deployErrorCode(err);
    return c.json(
      status === 500
        ? { error: "diff_failed", reason: err.reason }
        : { error: "diff_failed", reason: err.reason, message: err.message },
      status,
    );
  });

  app.post("/api/kit/deploy", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = AcceptedDeployRequest.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "invalid deploy request", issues: zodIssues(parsed.error) }, 400);
    }
    try {
      const accepted = await kit.acceptDeploy(parsed.data);
      return c.json(accepted, 202);
    } catch (error) {
      if (error instanceof PlanStaleError) {
        return c.json({ error: "plan_stale" }, 409);
      }
      if (error instanceof DeployInProgressError) {
        return c.json({ error: "deploy_in_progress", operationId: error.operationId }, 409);
      }
      if (error instanceof ImmutableInstallerStagingError) {
        return c.json({ error: error.code }, 409);
      }
      log().error(
        { module: "kit/routes", route: "deploy", err: String(error) },
        "deploy acceptance failed",
      );
      return c.json({ error: "deploy_unavailable" }, 500);
    }
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
