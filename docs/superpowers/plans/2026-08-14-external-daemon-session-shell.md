# External Daemon Session and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Hive Shell securely control either its managed local Daemon or one explicitly described external Daemon without exposing credentials to renderer JavaScript.

**Architecture:** Shared Zod contracts define readiness and the one-shot external descriptor. The Daemon keeps short-lived hashed session tokens in memory beside its durable token, while Electron main owns resolved connection state and preload exposes authenticated relative-path requests rather than credentials.

**Tech Stack:** TypeScript, Zod, Hono, Electron IPC/context isolation, Bun test

**Spec:** `docs/superpowers/specs/2026-08-14-arca-remote-capability-control-design.md`

## Global Constraints

- Production external endpoints are loopback HTTP only.
- The durable token never leaves the Daemon host; external sessions are memory-only, hashed, expiring, and revocable.
- Token bytes never enter renderer state, URLs, process arguments, persistent settings, or logs.
- External mode never probes, starts, drains, or stops a managed Daemon and requires `deployTargetMode: "real"`.
- Descriptor shape version is `1`; Daemon protocol version is `1`; maximum session lifetime is 86,400,000 ms.

---

### Task 1: Shared connection and readiness contracts

**Files:**
- Create: `packages/contract/src/connection.ts`
- Modify: `packages/contract/src/index.ts`
- Modify: `packages/shell/package.json`
- Modify: `packages/shell/src/daemon-ready.ts`
- Test: `packages/contract/src/__tests__/connection.test.ts`
- Test: `packages/shell/src/daemon-ready.test.ts`

**Interfaces:**
- Produces: `ReadyResponse`, `ExternalConnectionDescriptor`, `ExternalSession`, `ShellConnectionMetadata`, `DAEMON_PROTOCOL_VERSION`.
- Produces: `validateExternalReady(descriptor, ready): { ok: true } | { ok: false; message: string }`.

- [ ] **Step 1: Write failing schema and compatibility tests**

```ts
expect(ExternalConnectionDescriptor.parse(valid).version).toBe(1);
expect(() => ExternalConnectionDescriptor.parse({ ...valid, baseUrl: "https://arca" })).toThrow();
expect(validateExternalReady(valid, ready)).toEqual({ ok: true });
expect(validateExternalReady(valid, { ...ready, daemonInstanceId: "other" })).toEqual({
  ok: false,
  message: "external daemon instance does not match the connection descriptor",
});
```

- [ ] **Step 2: Run the focused tests and confirm the imports fail**

Run: `bun test packages/contract/src/__tests__/connection.test.ts packages/shell/src/daemon-ready.test.ts`

Expected: FAIL because the new schemas and validator do not exist.

- [ ] **Step 3: Add exact shared schemas and validator**

```ts
export const DAEMON_PROTOCOL_VERSION = 1;
export const ReadyResponse = z.object({
  status: z.literal("ok"),
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  buildVersion: z.string().min(1),
  daemonInstanceId: z.string().uuid(),
  runtimeRootId: z.string().min(16),
  daemonMode: z.enum(["dev", "packaged"]),
  deployTargetMode: z.enum(["sandbox", "real"]),
});
export const ExternalConnectionDescriptor = z.object({
  version: z.literal(1),
  baseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  }),
  displayName: z.string().min(1).max(80),
  expected: z.object({
    protocolRange: z.literal("1"),
    daemonInstanceId: z.string().uuid(),
    runtimeRootId: z.string().min(16),
    buildVersion: z.string().min(1),
  }),
  session: z.object({
    sessionId: z.string().uuid(),
    sessionToken: z.string().min(32),
    expiresAt: z.number().int().positive(),
  }),
});
```

- [ ] **Step 4: Run focused tests**

Run: `bun test packages/contract/src/__tests__/connection.test.ts packages/shell/src/daemon-ready.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/contract packages/shell/package.json packages/shell/src/daemon-ready.ts packages/shell/src/daemon-ready.test.ts
git commit -m "feat: define external daemon connection contract"
```

### Task 2: Expiring Daemon sessions and identity

**Files:**
- Create: `packages/daemon/src/server/sessions.ts`
- Test: `packages/daemon/src/server/__tests__/sessions.test.ts`
- Modify: `packages/daemon/src/server/auth.ts`
- Modify: `packages/daemon/src/server/index.ts`
- Test: `packages/daemon/src/server/__tests__/routes-ready.test.ts`
- Test: `packages/daemon/src/server/__tests__/routes-sessions.test.ts`

**Interfaces:**
- Consumes: `ReadyResponse`, `ExternalSession`, `DAEMON_PROTOCOL_VERSION`.
- Produces: `SessionRegistry.mint(ttlMs)`, `SessionRegistry.authenticate(token)`, `SessionRegistry.revoke(id)`.
- Produces: durable-only `POST /api/external-sessions` and `DELETE /api/external-sessions/:id`.

- [ ] **Step 1: Write failing registry tests**

```ts
const sessions = createSessionRegistry({ now: () => now, randomBytes: () => Buffer.alloc(32, 7) });
const minted = sessions.mint(60_000);
expect(sessions.authenticate(minted.sessionToken)).toBe(true);
expect(sessions.debugRecords()[0]?.tokenHash).not.toContain(minted.sessionToken);
now += 60_001;
expect(sessions.authenticate(minted.sessionToken)).toBe(false);
```

- [ ] **Step 2: Run the registry test**

Run: `bun test packages/daemon/src/server/__tests__/sessions.test.ts`

Expected: FAIL because `createSessionRegistry` is missing.

- [ ] **Step 3: Implement the in-memory hashed registry**

```ts
export type SessionRegistry = {
  mint(ttlMs?: number): ExternalSession;
  authenticate(token: string): boolean;
  revoke(sessionId: string): boolean;
};

export function createSessionRegistry(deps = productionSessionDeps()): SessionRegistry {
  const records = new Map<string, { tokenHash: string; expiresAt: number }>();
  return {
    mint(ttlMs = MAX_EXTERNAL_SESSION_MS) {
      const sessionId = crypto.randomUUID();
      const sessionToken = deps.randomBytes(32).toString("base64url");
      const expiresAt = deps.now() + Math.min(Math.max(ttlMs, 1), MAX_EXTERNAL_SESSION_MS);
      records.set(sessionId, { tokenHash: sha256(sessionToken), expiresAt });
      return { sessionId, sessionToken, expiresAt };
    },
    authenticate(token) {
      const hash = sha256(token);
      for (const [id, record] of records) {
        if (record.expiresAt <= deps.now()) records.delete(id);
        else if (timingSafeEqualHex(hash, record.tokenHash)) return true;
      }
      return false;
    },
    revoke(sessionId) { return records.delete(sessionId); },
  };
}
```

- [ ] **Step 4: Write failing route tests for durable-only mint/revoke and readiness identity**

```ts
const minted = await json(server.app, "/api/external-sessions", durableToken, { method: "POST" });
expect(minted.status).toBe(201);
expect(await status(server.app, "/api/kit/state", minted.body.sessionToken)).toBe(200);
expect(await status(server.app, "/api/external-sessions", minted.body.sessionToken, { method: "POST" })).toBe(403);
expect(ReadyResponse.parse(await ready(server.app)).runtimeRootId).toBe(server.runtimeRootId);
```

- [ ] **Step 5: Extend auth with credential class and add the routes**

```ts
export type AuthKind = "durable" | "session";
declare module "hono" { interface ContextVariableMap { authKind: AuthKind } }

if (provided === durableToken) c.set("authKind", "durable");
else if (sessions.authenticate(provided)) c.set("authKind", "session");
else return c.json({ error: "unauthorized" }, 401);
```

Use a stable `runtimeRootId` stored at `<runtimeRoot>/.runtime-id`, a per-process UUID for `daemonInstanceId`, and `package.json` version for `buildVersion`.

- [ ] **Step 6: Run focused server tests**

Run: `bun test packages/daemon/src/server/__tests__/sessions.test.ts packages/daemon/src/server/__tests__/routes-ready.test.ts packages/daemon/src/server/__tests__/routes-sessions.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the Daemon session slice**

```bash
git add packages/daemon/src/server
git commit -m "feat: authenticate expiring external sessions"
```

### Task 3: One-shot descriptor loading and renderer-safe requests

**Files:**
- Create: `packages/shell/src/connection.ts`
- Test: `packages/shell/src/connection.test.ts`
- Modify: `packages/shell/src/main.ts`
- Modify: `packages/shell/src/preload.ts`
- Modify: `packages/ui/src/api.ts`
- Modify: `packages/ui/src/main.tsx`
- Test: `packages/ui/src/__tests__/api-bridge.test.ts`

**Interfaces:**
- Produces: `resolveShellConnection(argv, env): ManagedConnection | ExternalConnection`.
- Produces renderer bridge `daemon.request(path, init)` and `connection: { displayName, kind }`; neither contains a token.
- Browser development retains explicit `ApiConfig = { kind: "browser"; baseUrl; token }`.

- [ ] **Step 1: Write failing descriptor tests**

```ts
const path = writeDescriptor(validDescriptor, 0o600);
const connection = loadExternalDescriptor(path, { uid: process.getuid?.() });
expect(connection.sessionToken).toBe(validDescriptor.session.sessionToken);
expect(existsSync(path)).toBe(false);
expect(() => loadExternalDescriptor(writeDescriptor(validDescriptor, 0o644))).toThrow("owner-only");
```

- [ ] **Step 2: Run the Shell test**

Run: `bun test packages/shell/src/connection.test.ts`

Expected: FAIL because descriptor loading is missing.

- [ ] **Step 3: Implement descriptor validation, permission checks, and immediate unlink**

```ts
export function loadExternalDescriptor(path: string): ExternalConnection {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("connection descriptor must be an owner-only regular file");
  try {
    const descriptor = ExternalConnectionDescriptor.parse(JSON.parse(readFileSync(path, "utf8")));
    if (descriptor.session.expiresAt <= Date.now()) throw new Error("external session has expired");
    return { kind: "external", ...descriptor };
  } finally {
    unlinkSync(path);
  }
}
```

- [ ] **Step 4: Replace renderer credentials with a relative-path request bridge**

```ts
contextBridge.exposeInMainWorld("__hive", {
  connection: connectionMetadata,
  daemon: {
    request: async (path: string, init?: SerializedRequest) => {
      if (!path.startsWith("/api/")) throw new Error("daemon path must be relative /api/*");
      const { baseUrl, token } = await ipcRenderer.invoke("hive:getDaemonConnection");
      const response = await fetch(new URL(path, baseUrl), {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${token}` },
      });
      return serializeResponse(response);
    },
  },
});
```

Bind `hive:getDaemonConnection` to the created window's `webContents.id`; reject every other sender. Keep `{ baseUrl, token }` only in Electron main/preload isolated state.

- [ ] **Step 5: Update the UI client and prove the bridge is secret-free**

```ts
expect(window.__hive).not.toHaveProperty("token");
expect(window.__hive).not.toHaveProperty("baseUrl");
expect(JSON.stringify(window.__hive)).not.toContain(sessionToken);
expect(await api.getKitState(resolveApiConfig())).toEqual(stateFixture);
```

Expose `{ kind, displayName, status }` as non-secret connection metadata. On transport failure set status to `disconnected`, retry reads with bounded backoff, and refetch `/api/kit/overview` after the request bridge reconnects.

- [ ] **Step 6: Run Shell/UI focused tests and typecheck**

Run: `bun test packages/shell/src/connection.test.ts packages/ui/src/__tests__/api-bridge.test.ts && bun run --filter @hive/shell typecheck && bun run --filter @hive/ui typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the request bridge**

```bash
git add packages/shell packages/ui/src/api.ts packages/ui/src/main.tsx packages/ui/src/__tests__/api-bridge.test.ts
git commit -m "feat: keep daemon credentials out of renderer state"
```

### Task 4: Strict managed versus external Shell lifecycle

**Files:**
- Modify: `packages/shell/src/main.ts`
- Create: `packages/shell/src/lifecycle.ts`
- Test: `packages/shell/src/lifecycle.test.ts`
- Test: `packages/shell/tests/external-mode.e2e.ts`

**Interfaces:**
- Consumes: resolved `ShellConnection` and `validateExternalReady`.
- Produces: lifecycle policy `shouldManageDaemon(connection)` and external terminal startup errors.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
expect(shouldManageDaemon({ kind: "managed" })).toBe(true);
expect(shouldManageDaemon(externalConnection)).toBe(false);
expect(actionsForQuit(externalConnection, { activeOperation: true })).toEqual(["quit-shell"]);
expect(actionsForQuit({ kind: "managed" }, { activeOperation: true })).toEqual(["confirm", "drain"]);
```

- [ ] **Step 2: Run the focused test**

Run: `bun test packages/shell/src/lifecycle.test.ts`

Expected: FAIL because the policy module is missing.

- [ ] **Step 3: Gate every managed lifecycle action on the discriminant**

```ts
if (connection.kind === "managed") await ensureManagedDaemon();
else await requireExternalDaemon(connection);

if (connection.kind === "managed" && shouldConfirmClose(activeOperation, closeConfirmed)) {
  confirmManagedClose();
}
if (connection.kind === "managed") drainSpawnedDaemon();
```

Retain the resolved connection in main memory so macOS activation recreates a window with the same connection.

- [ ] **Step 4: Run lifecycle, e2e, and full Shell tests**

Run: `bun test packages/shell/src packages/shell/tests/external-mode.e2e.ts && bun run --filter @hive/shell typecheck`

Expected: PASS, including assertions that the spawn/kill spies have zero calls in external mode.

- [ ] **Step 5: Commit strict lifecycle separation**

```bash
git add packages/shell
git commit -m "feat: add strict external shell lifecycle"
```
