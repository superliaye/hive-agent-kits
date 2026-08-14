import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { z } from "zod";

const LoopbackHttpUrl = z.string().url().refine(
  (value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  },
  { message: "baseUrl must be a credential-free loopback HTTP origin" },
);

export const ExternalConnectionDescriptorSchema = z.object({
  version: z.literal(1),
  baseUrl: LoopbackHttpUrl,
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

export type ExternalConnectionDescriptor = z.infer<typeof ExternalConnectionDescriptorSchema>;
export type ManagedConnection = { kind: "managed" };
export type ExternalConnection = ExternalConnectionDescriptor & { kind: "external" };
export type ShellLaunch = ManagedConnection | ExternalConnection;

export type DescriptorDeps = {
  now(): number;
  uid?: number;
};

function productionDeps(): DescriptorDeps {
  return { now: Date.now, uid: process.getuid?.() };
}

export function loadExternalDescriptor(
  path: string,
  deps: DescriptorDeps = productionDeps(),
): ExternalConnection {
  try {
    const stat = lstatSync(path);
    const wrongOwner = deps.uid !== undefined && stat.uid !== deps.uid;
    if (!stat.isFile() || wrongOwner || (stat.mode & 0o077) !== 0) {
      throw new Error("connection descriptor must be an owner-only regular file");
    }
    const parsed = ExternalConnectionDescriptorSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    if (parsed.session.expiresAt <= deps.now()) {
      throw new Error("external session has expired; relaunch the external connection");
    }
    return { kind: "external", ...parsed };
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // A concurrent cleanup may already have consumed the one-shot file.
    }
  }
}

export function resolveShellLaunch(
  argv: readonly string[],
  deps: DescriptorDeps = productionDeps(),
): ShellLaunch {
  const prefix = "--hive-external-descriptor=";
  const descriptors = argv.filter((arg) => arg.startsWith(prefix));
  if (descriptors.length === 0) return { kind: "managed" };
  if (descriptors.length !== 1) throw new Error("exactly one external connection descriptor is allowed");
  const descriptorArg = descriptors[0];
  const path = descriptorArg?.slice(prefix.length) ?? "";
  if (path.length === 0) throw new Error("external connection descriptor path is empty");
  return loadExternalDescriptor(path, deps);
}
