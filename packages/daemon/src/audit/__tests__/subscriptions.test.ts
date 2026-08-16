/**
 * Integration tests for wireSubscriptions — the cross-module seam that
 * attaches emitter modules to the audit log.
 *
 * Audit covers user/agent-driven side effects (ADR-0004 "Audit vs trace"
 * amendment). System-driven scan/lifecycle events flow through the trace
 * log, not audit.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { z } from "zod";
import { configRuntime } from "../../config/effect/config-live.ts";
import {
  SecretsLive,
  type SecretsSvc,
  Secrets as SecretsTag,
} from "../../secrets/effect/secrets-live.ts";
import { AuditLive, type AuditSvc, Audit as AuditTag } from "../effect/audit-live.ts";
import { wireSubscriptions } from "../subscriptions.ts";

// Runtimes resolved across this file's tests; disposed in afterEach.
const runtimes: Array<{ dispose(): Promise<void> }> = [];
function makeSecrets(): SecretsSvc {
  const runtime = ManagedRuntime.make(SecretsLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(SecretsTag);
}
function makeAudit(): AuditSvc {
  const runtime = ManagedRuntime.make(AuditLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(AuditTag);
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.dispose();
});

describe("wireSubscriptions", () => {
  test("config.set produces a config.change audit row", async () => {
    const audit = makeAudit();
    const schema = z.object({ theme: z.string() });
    const { svc: config, dispose: disposeConfig } = configRuntime({
      mode: "memory",
      initial: { theme: "light" },
      schema,
    });
    const dispose = wireSubscriptions(audit, { config });

    await config.set("theme", "dark");

    const rows = await audit.query({ source: "config" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("config.change");
    expect(rows[0]?.payload).toMatchObject({
      key: "theme",
      previous: "light",
      current: "dark",
      source: "set",
    });

    dispose();
    disposeConfig();
  });

  // Privacy redaction: the audit subscriber must strip color hex out of
  // `appearance` change payloads (mode-picker is fine, accent / overrides
  // are personal taste). Documented in audit/subscriptions.ts.
  test("appearance config.change records only the mode, never color hex", async () => {
    const audit = makeAudit();
    const schema = z.object({
      appearance: z.object({
        mode: z.enum(["light", "dark", "system"]),
        dark: z.object({ accent: z.string().optional() }).optional(),
      }),
    });
    const { svc: config, dispose: disposeConfig } = configRuntime({
      mode: "memory",
      initial: { appearance: { mode: "system" } },
      schema,
    });
    const dispose = wireSubscriptions(audit, { config });

    await config.set("appearance", {
      mode: "dark",
      dark: { accent: "#deadbeef" },
    });

    const rows = await audit.query({ source: "config" });
    expect(rows.length).toBe(1);
    const payload = rows[0]?.payload as { key: string; previous: unknown; current: unknown };
    expect(payload.key).toBe("appearance");
    expect(payload.previous).toEqual({ mode: "system" });
    expect(payload.current).toEqual({ mode: "dark" });
    // Defense-in-depth: the literal hex must not appear anywhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain("deadbeef");

    dispose();
    disposeConfig();
  });

  test("sources config.change never records working-tree allowlist paths", async () => {
    const audit = makeAudit();
    const schema = z.object({ sources: z.object({ workingTreeRoots: z.array(z.string()) }) });
    const { svc: config, dispose: disposeConfig } = configRuntime({
      mode: "memory",
      initial: { sources: { workingTreeRoots: [] } },
      schema,
    });
    const dispose = wireSubscriptions(audit, { config });
    const privateRoot = "/private/daemon/worktree";

    await config.set("sources", { workingTreeRoots: [privateRoot] });

    const rows = await audit.query({ source: "config" });
    expect(rows[0]?.payload).toMatchObject({
      key: "sources",
      previous: { workingTreeRoots: "[redacted]" },
      current: { workingTreeRoots: "[redacted]" },
    });
    expect(JSON.stringify(rows)).not.toContain(privateRoot);

    dispose();
    disposeConfig();
  });

  // Secrets is user/agent-driven, so its mutating verbs ARE audited. The
  // verbs are async + block-on-failure (4.2-A1): a write produces a row, and
  // a persist failure must fail the originating op (ADR-0004 Verify item 4,
  // no silent-degrade).
  test("setApiKey produces a secret.write audit row", async () => {
    const audit = makeAudit();
    const secrets = makeSecrets();
    const dispose = wireSubscriptions(audit, { secrets });

    await secrets.setApiKey("openai", "sk-test");

    const rows = await audit.query({ source: "secrets" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("secret.write");
    expect(rows[0]?.payload).toMatchObject({ provider: "openai", kind: "apiKey", op: "create" });
    // Never the secret value itself (ADR-0004 redaction).
    expect(JSON.stringify(rows[0])).not.toContain("sk-test");

    dispose();
  });

  test("a failing audit subscriber fails the originating setApiKey (no silent-degrade)", async () => {
    const audit = makeAudit();
    const secrets = makeSecrets();
    const dispose = wireSubscriptions(audit, { secrets });

    // Simulate a persist failure on the audited write path: a subscriber on the
    // same emitter throws. Because setApiKey now awaits the emit (4.2-A1),
    // the throw propagates and the write rejects — it is NOT silently swallowed.
    secrets.events.on("secret.write", () => {
      throw new Error("audit persist failed");
    });

    await expect(secrets.setApiKey("openai", "sk-test")).rejects.toThrow(/audit persist failed/);
    // Side effect not committed: the provider was never stored (emit-before-commit).
    expect(secrets.status("openai")).toBe("missing");

    dispose();
  });

  test("disposer detaches; later changes don't reach audit", async () => {
    const audit = makeAudit();
    const schema = z.object({ count: z.number() });
    const { svc: config, dispose: disposeConfig } = configRuntime({
      mode: "memory",
      initial: { count: 0 },
      schema,
    });
    const dispose = wireSubscriptions(audit, { config });

    await config.set("count", 1);
    dispose();
    await config.set("count", 2);

    const rows = await audit.query({ source: "config" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.payload).toMatchObject({ current: 1 });
    // Was: the second set("count", 2) — confirms the disposer detached.

    disposeConfig();
  });
});
