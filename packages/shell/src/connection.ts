import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

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
  platform?: NodeJS.Platform;
  uid?: number;
  unlink?(path: string): void;
};

function productionDeps(): DescriptorDeps {
  return { now: Date.now, platform: process.platform, uid: process.getuid?.() };
}

export function loadExternalDescriptor(
  path: string,
  deps: DescriptorDeps = productionDeps(),
): ExternalConnection {
  if ((deps.platform ?? process.platform) === "win32") {
    throw new Error("external connection descriptors are unsupported on Windows");
  }
  const consume = deps.unlink ?? unlinkSync;
  const resolvedPath = resolve(path);
  const parent = dirname(resolvedPath);
  const parentStat = lstatSync(parent);
  const parentSharedWritable = (parentStat.mode & 0o022) !== 0;
  const parentSticky = (parentStat.mode & 0o1000) !== 0;
  const wrongParentOwner =
    deps.uid !== undefined && parentStat.uid !== deps.uid && parentStat.uid !== 0;
  if (!parentStat.isDirectory() || wrongParentOwner || (parentSharedWritable && !parentSticky)) {
    throw new Error("connection descriptor parent is not owner-controlled");
  }
  const staging = join(parent, `.hive-descriptor-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);
  const stagedPath = join(staging, "connection.json");
  let fd: number | undefined;
  let connection: ExternalConnection | undefined;
  let loadError: unknown;
  let cleanupError: unknown;
  try {
    renameSync(resolvedPath, stagedPath);
    try {
      fd = openSync(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      const refusedLink =
        typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
      if (refusedLink) {
        throw new Error("connection descriptor must be an owner-only regular file");
      }
      throw error;
    }
    const stat = fstatSync(fd);
    const wrongOwner = deps.uid !== undefined && stat.uid !== deps.uid;
    if (!stat.isFile() || wrongOwner || (stat.mode & 0o077) !== 0) {
      throw new Error("connection descriptor must be an owner-only regular file");
    }
    const parsed = ExternalConnectionDescriptorSchema.parse(
      JSON.parse(readFileSync(fd, "utf8")) as unknown,
    );
    if (parsed.session.expiresAt <= deps.now()) {
      throw new Error("external session has expired; relaunch the external connection");
    }
    connection = { kind: "external", ...parsed };
  } catch (error: unknown) {
    loadError = error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error: unknown) {
        cleanupError = error;
      }
    }
    try {
      consume(stagedPath);
    } catch (error: unknown) {
      const missing =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      if (!missing) {
        cleanupError = error;
      }
    } finally {
      try {
        rmdirSync(staging);
      } catch {
        // A failed consume is reported above; retain its staged evidence.
      }
    }
  }
  if (cleanupError !== undefined) {
    throw new Error("external connection descriptor could not be consumed", {
      cause: cleanupError,
    });
  }
  if (loadError !== undefined) throw loadError;
  if (connection === undefined)
    throw new Error("external connection descriptor could not be loaded");
  return connection;
}

export function resolveShellLaunch(
  argv: readonly string[],
  deps: DescriptorDeps = productionDeps(),
): ShellLaunch {
  const flag = "--hive-external-descriptor";
  const prefix = `${flag}=`;
  const reserved = argv.filter((arg) => arg.startsWith(flag));
  if (reserved.length === 0) return { kind: "managed" };
  if (reserved.some((arg) => !arg.startsWith(prefix))) {
    throw new Error("external connection descriptor flag must use one non-empty assignment");
  }
  const descriptors = reserved;
  if (descriptors.length !== 1)
    throw new Error("exactly one external connection descriptor is allowed");
  const descriptorArg = descriptors[0];
  const path = descriptorArg?.slice(prefix.length) ?? "";
  if (path.length === 0) throw new Error("external connection descriptor path is empty");
  return loadExternalDescriptor(path, deps);
}
