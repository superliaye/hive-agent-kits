// Bearer-token middleware. Token comes from the daemon's runtime <runtime>/.token.
// /api/ready and /api/events take the token via query string because EventSource
// cannot send Authorization headers from the browser.

import { createMiddleware } from "hono/factory";
import type { SessionRegistry } from "./sessions.ts";

export type AuthKind = "durable" | "session";

declare module "hono" {
  interface ContextVariableMap {
    authKind: AuthKind;
  }
}

export function bearerAuth(durableToken: string, sessions: SessionRegistry) {
  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    if (path === "/api/ready") {
      await next();
      return;
    }

    let provided: string | null = null;
    if (path === "/api/events") {
      provided = c.req.query("token") ?? null;
    } else {
      const header = c.req.header("authorization");
      if (header?.startsWith("Bearer ")) {
        provided = header.slice("Bearer ".length).trim();
      }
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
