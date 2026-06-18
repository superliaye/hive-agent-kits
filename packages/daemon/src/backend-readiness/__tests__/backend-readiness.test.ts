// Unit-test the readiness join with injected probe + secrets fakes. Locks the
// honesty invariant: a stored OAuth token is NEVER reported as operative api-key
// auth — it surfaces as cli-managed.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { BackendStatus } from "../../backend-probe/types.ts";
import {
  BackendReadinessLive,
  BackendReadinessService,
  type ReadinessProbePort,
  type ReadinessSecretsPort,
} from "../effect/backend-readiness-live.ts";
import type { BackendReadiness } from "../types.ts";

function probeWith(statuses: BackendStatus[]): ReadinessProbePort {
  return { probeAll: async () => statuses };
}

function secretsWith(entries: ReturnType<ReadinessSecretsPort["list"]>): ReadinessSecretsPort {
  return { list: () => entries };
}

async function listReadiness(
  probe: ReadinessProbePort,
  secrets: ReadinessSecretsPort,
): Promise<BackendReadiness[]> {
  const svc = await Effect.runPromise(
    BackendReadinessService.pipe(Effect.provide(BackendReadinessLive({ probe, secrets }))),
  );
  return svc.list();
}

const installedClaude: BackendStatus = {
  backend: "claude-code",
  installed: true,
  version: "2.0.0",
  reason: "ok",
  checkedAt: 1,
};
const installedCodex: BackendStatus = {
  backend: "codex",
  installed: true,
  version: "1.0.0",
  reason: "ok",
  checkedAt: 1,
};

describe("backend-readiness join", () => {
  test("(a) installed + apiKey secret → state api-key, stored.status ok", async () => {
    const rows = await listReadiness(
      probeWith([installedClaude]),
      secretsWith([{ provider: "anthropic", kind: "apiKey", status: "ok", addedAt: 10 }]),
    );
    const claude = rows.find((r) => r.backend === "claude-code");
    expect(claude?.auth.state).toBe("api-key");
    expect(claude?.auth.stored).toEqual({ kind: "apiKey", status: "ok", addedAt: 10 });
  });

  test("(b) installed + expired oauth → cli-managed, stored.kind oauth, status expired (NOT api-key)", async () => {
    const rows = await listReadiness(
      probeWith([installedClaude]),
      secretsWith([{ provider: "anthropic", kind: "oauth", status: "expired", addedAt: 5 }]),
    );
    const claude = rows.find((r) => r.backend === "claude-code");
    expect(claude?.auth.state).toBe("cli-managed");
    expect(claude?.auth.state).not.toBe("api-key");
    expect(claude?.auth.stored?.kind).toBe("oauth");
    expect(claude?.auth.stored?.status).toBe("expired");
  });

  test("(c) installed + no secret → cli-managed, no stored", async () => {
    const rows = await listReadiness(probeWith([installedClaude]), secretsWith([]));
    const claude = rows.find((r) => r.backend === "claude-code");
    expect(claude?.auth.state).toBe("cli-managed");
    expect(claude?.auth.stored).toBeUndefined();
  });

  test("(d) not-installed backend still reports its provider + auth state", async () => {
    const notInstalled: BackendStatus = {
      backend: "codex",
      installed: false,
      version: null,
      reason: "not_installed",
      checkedAt: 1,
    };
    const rows = await listReadiness(probeWith([notInstalled]), secretsWith([]));
    const codex = rows.find((r) => r.backend === "codex");
    expect(codex?.provider).toBe("openai-codex");
    expect(codex?.installed).toBe(false);
    expect(codex?.auth.state).toBe("cli-managed");
  });

  test("(e) codex provider === 'openai-codex'; claude-code provider === 'anthropic'", async () => {
    const rows = await listReadiness(probeWith([installedClaude, installedCodex]), secretsWith([]));
    expect(rows.find((r) => r.backend === "claude-code")?.provider).toBe("anthropic");
    expect(rows.find((r) => r.backend === "codex")?.provider).toBe("openai-codex");
  });
});
