// Bearer-token middleware. The minimal /api/ready liveness probe is public.
// EventSource cannot send Authorization headers, so /api/events takes its token
// from the query string; every other protected route uses the header.

import { createMiddleware } from "hono/factory";
import type { SessionRegistry } from "./sessions.ts";

export type AuthKind = "durable" | "session";

declare module "hono" {
  interface ContextVariableMap {
    authKind: AuthKind | undefined;
  }
}

export function bearerAuth(durableToken: string, sessions: SessionRegistry) {
  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    let provided: string | null = null;
    if (path === "/api/events") {
      provided = c.req.query("token") ?? null;
    } else {
      const header = c.req.header("authorization");
      if (header?.startsWith("Bearer ")) {
        provided = header.slice("Bearer ".length).trim();
      }
    }

    if (!provided && path === "/api/ready") {
      await next();
      return;
    }
    if (!provided) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (provided === durableToken) c.set("authKind", "durable");
    else if (sessions.authenticate(provided)) c.set("authKind", "session");
    else return c.json({ error: "unauthorized" }, 401);
    await next();
  });
}
