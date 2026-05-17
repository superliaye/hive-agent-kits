// Bearer-token middleware. Token comes from the daemon's runtime <runtime>/.token.
// /api/ready and /api/events take the token via query string because EventSource
// cannot send Authorization headers from the browser.

import { createMiddleware } from "hono/factory";

export function bearerAuth(token: string) {
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

    if (!provided || provided !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}
