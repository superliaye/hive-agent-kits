import { z } from "zod";

const ReadyResponse = z.object({
  status: z.literal("ok"),
  daemonMode: z.enum(["dev", "packaged"]),
  deployTargetMode: z.enum(["sandbox", "real"]),
});

export type ReadyResponse = z.infer<typeof ReadyResponse>;

export type ReadyProbe =
  | { ready: false }
  | { ready: true; metadata: ReadyResponse | null };

export type ShellMode = "dev" | "packaged";

export function parseReadyProbe(responseOk: boolean, body: unknown): ReadyProbe {
  if (!responseOk) return { ready: false };
  const parsed = ReadyResponse.safeParse(body);
  return { ready: true, metadata: parsed.success ? parsed.data : null };
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
