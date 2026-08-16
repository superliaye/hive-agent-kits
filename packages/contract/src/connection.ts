import { z } from "zod";

export const DAEMON_PROTOCOL_VERSION = 1 as const;
export const EXTERNAL_DESCRIPTOR_VERSION = 1 as const;
export const EXTERNAL_PROTOCOL_RANGE = "1" as const;
export const MAX_EXTERNAL_SESSION_MS = 86_400_000;

export const ReadyResponse = z.object({
  status: z.literal("ok"),
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  buildVersion: z.string().min(1),
  daemonInstanceId: z.string().uuid(),
  runtimeRootId: z.string().min(16),
  daemonMode: z.enum(["dev", "packaged"]),
  deployTargetMode: z.enum(["sandbox", "real"]),
  activeExternalSessions: z.number().int().nonnegative(),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;

export const ExternalSession = z.object({
  sessionId: z.string().uuid(),
  sessionToken: z.string().min(32),
  expiresAt: z.number().int().positive(),
});
export type ExternalSession = z.infer<typeof ExternalSession>;

const LoopbackHttpUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" ||
          url.hostname === "localhost" ||
          url.hostname === "[::1]") &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === ""
      );
    },
    { message: "baseUrl must be a credential-free loopback HTTP origin" },
  );

export const ExternalConnectionDescriptor = z.object({
  version: z.literal(EXTERNAL_DESCRIPTOR_VERSION),
  baseUrl: LoopbackHttpUrl,
  displayName: z.string().min(1).max(80),
  expected: z.object({
    protocolRange: z.literal(EXTERNAL_PROTOCOL_RANGE),
    daemonInstanceId: z.string().uuid(),
    runtimeRootId: z.string().min(16),
    buildVersion: z.string().min(1),
  }),
  session: ExternalSession,
});
export type ExternalConnectionDescriptor = z.infer<typeof ExternalConnectionDescriptor>;

export const ShellConnectionMetadata = z.object({
  kind: z.enum(["managed", "external"]),
  displayName: z.string().min(1).max(80),
  status: z.enum(["connected", "disconnected", "reauthentication_required"]),
});
export type ShellConnectionMetadata = z.infer<typeof ShellConnectionMetadata>;
