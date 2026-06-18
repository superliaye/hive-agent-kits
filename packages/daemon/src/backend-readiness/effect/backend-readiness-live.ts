// Effect-native Backend Readiness projection (mirrors BackendProbeLive). The
// service joins the pure-detection probe with the Secrets auth state per
// backend. Both deps are reached through NARROW, consumer-owned ports defined in
// THIS module — the providers' surface types are never imported here.

import { Context, Layer } from "effect";
import type { BackendStatus, ProbeableBackend } from "../../backend-probe/types.ts";
import { BACKEND_PROVIDER, type BackendReadiness } from "../types.ts";

// Probe port: only the verb this projection reads (the full set, one call).
export type ReadinessProbePort = {
  probeAll(): Promise<BackendStatus[]>;
};

// Secrets port: the configured-providers listing this projection joins against.
// `list()` only yields stored entries (never status "missing" — that is reserved
// for a single-provider lookup of an absent entry), so the port narrows to the
// two statuses it can actually receive. The composition root adapts the resolved
// Secrets onto this shape.
export type ReadinessSecretsPort = {
  list(): ReadonlyArray<{
    provider: string;
    kind: "apiKey" | "oauth";
    status: "ok" | "expired";
    addedAt: number;
    refreshedAt?: number;
  }>;
};

export type BackendReadinessSvc = {
  list(): Promise<BackendReadiness[]>;
};

// Tag is `BackendReadinessService` (not `BackendReadiness`) — the latter is the
// Zod wire schema/type in ../types.ts.
export class BackendReadinessService extends Context.Service<
  BackendReadinessService,
  BackendReadinessSvc
>()("backend-readiness/BackendReadiness") {}

type ConfiguredEntry = ReturnType<ReadinessSecretsPort["list"]>[number];

// Derive the auth row for one backend from its mapped provider's stored Secret.
//   apiKey  → api-key      (operative — Hive injects the key into the run)
//   oauth   → cli-managed  (the token is fetched but NOT injected; ambient login)
//   none    → cli-managed  (no stored secret, ambient CLI login)
function deriveAuth(configured: ConfiguredEntry | undefined): BackendReadiness["auth"] {
  if (!configured) {
    return { state: "cli-managed" };
  }
  if (configured.kind === "apiKey") {
    return {
      state: "api-key",
      stored: {
        kind: "apiKey",
        status: configured.status,
        addedAt: configured.addedAt,
        ...(configured.refreshedAt !== undefined && { refreshedAt: configured.refreshedAt }),
      },
    };
  }
  return {
    state: "cli-managed",
    stored: {
      kind: "oauth",
      status: configured.status,
      addedAt: configured.addedAt,
      ...(configured.refreshedAt !== undefined && { refreshedAt: configured.refreshedAt }),
    },
  };
}

function buildSvc(probe: ReadinessProbePort, secrets: ReadinessSecretsPort): BackendReadinessSvc {
  return {
    list: async () => {
      const statuses = await probe.probeAll();
      const configured = secrets.list();
      return statuses.map((status): BackendReadiness => {
        const provider = BACKEND_PROVIDER[status.backend as ProbeableBackend];
        const entry = configured.find((c) => c.provider === provider);
        return { ...status, provider, auth: deriveAuth(entry) };
      });
    },
  };
}

export type CreateBackendReadinessOptions = {
  probe: ReadinessProbePort;
  secrets: ReadinessSecretsPort;
};

// Build a no-dep Layer from already-resolved ports. The composition root adapts
// the resolved BackendProbe + Secrets onto the narrow ports and passes them in,
// so this module's Layer never leaks a BackendProbe / Secrets requirement.
export function BackendReadinessLive(
  opts: CreateBackendReadinessOptions,
): Layer.Layer<BackendReadinessService> {
  return Layer.succeed(BackendReadinessService, buildSvc(opts.probe, opts.secrets));
}
