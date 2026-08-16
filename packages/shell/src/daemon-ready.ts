import { z } from "zod";
import type { ExternalConnection } from "./connection.ts";

const ReadyResponseSchema = z.object({
  status: z.literal("ok"),
  protocolVersion: z.literal(1),
  buildVersion: z.string().min(1),
  daemonInstanceId: z.string().uuid(),
  runtimeRootId: z.string().min(16),
  daemonMode: z.enum(["dev", "packaged"]),
  deployTargetMode: z.enum(["sandbox", "real"]),
});

export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export type ShellReleaseIdentity = {
  protocolRange: "1";
  buildVersion: string;
};

export type ReadyProbe =
  | { ready: false; reason?: "unauthorized" }
  | { ready: true; metadata: ReadyResponse | null };

export type ShellMode = "dev" | "packaged";

export function parseReadyProbe(responseStatus: number, body: unknown): ReadyProbe {
  if (responseStatus === 401) return { ready: false, reason: "unauthorized" };
  if (responseStatus < 200 || responseStatus >= 300) return { ready: false };
  const parsed = ReadyResponseSchema.safeParse(body);
  return { ready: true, metadata: parsed.success ? parsed.data : null };
}

export async function probeExternalReadyWithRetries(
  probe: () => Promise<ReadyProbe>,
  retryDelaysMs: readonly number[],
): Promise<ReadyProbe> {
  let result = await probe();
  for (const delayMs of retryDelaysMs) {
    if (result.ready || result.reason === "unauthorized") return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await probe();
  }
  return result;
}

export type ExternalReadyValidation = { ok: true } | { ok: false; message: string };

export function validateExternalReady(
  descriptor: Pick<ExternalConnection, "expected">,
  ready: ReadyResponse,
  shellRelease: ShellReleaseIdentity,
): ExternalReadyValidation {
  if (
    descriptor.expected.protocolRange !== shellRelease.protocolRange ||
    shellRelease.protocolRange !== String(ready.protocolVersion)
  ) {
    return { ok: false, message: "external daemon protocol is incompatible with this shell" };
  }
  if (descriptor.expected.daemonInstanceId !== ready.daemonInstanceId) {
    return {
      ok: false,
      message: "external daemon instance does not match the connection descriptor",
    };
  }
  if (descriptor.expected.runtimeRootId !== ready.runtimeRootId) {
    return {
      ok: false,
      message: "external daemon runtime root does not match the connection descriptor",
    };
  }
  if (descriptor.expected.buildVersion !== shellRelease.buildVersion) {
    return { ok: false, message: "connection descriptor build does not match this shell" };
  }
  if (shellRelease.buildVersion !== ready.buildVersion) {
    return { ok: false, message: "external daemon build does not match this shell" };
  }
  if (ready.daemonMode !== "packaged") {
    return { ok: false, message: "external daemon is not a packaged release" };
  }
  if (ready.deployTargetMode !== "real") {
    return { ok: false, message: "external daemon is not configured for real deployment targets" };
  }
  return { ok: true };
}

export function canReuseReadyDaemon(shellMode: ShellMode, probe: ReadyProbe): boolean {
  if (!probe.ready) return false;
  if (shellMode === "dev") return true;
  return probe.metadata?.daemonMode === "packaged" && probe.metadata.deployTargetMode === "real";
}

export function incompatibleDaemonMessage(probe: ReadyProbe): string {
  if (!probe.ready) return "daemon is not ready";
  if (!probe.metadata) {
    return "packaged shell found a daemon on the configured port, but /api/ready did not expose compatibility metadata";
  }
  return `packaged shell found an incompatible daemon on the configured port: daemonMode=${probe.metadata.daemonMode}, deployTargetMode=${probe.metadata.deployTargetMode}`;
}
