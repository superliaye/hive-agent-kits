import { type PastedSourceInput, SourceLocator } from "@hive/contract";
import { Data, Effect } from "effect";
import { log } from "../../lib/log.ts";
import { productionGitProcess } from "./git-process.ts";

type PastedGitLocator = Extract<PastedSourceInput["locator"], { kind: "git" }>;
type GitLocator = Extract<SourceLocator, { kind: "git" }>;

class DefaultBranchUnavailable extends Data.TaggedError("DefaultBranchUnavailable")<{
  readonly message: string;
}> {}

export function resolveGitLocator(
  locator: PastedGitLocator,
): Effect.Effect<GitLocator, DefaultBranchUnavailable> {
  if (locator.revision.mode !== "track" || locator.revision.ref !== "HEAD") {
    return Effect.succeed(locator);
  }
  return Effect.tryPromise({
    try: async () => {
      const result = await productionGitProcess().run(
        [
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "ls-remote",
          "--symref",
          locator.repoUrl,
          "HEAD",
        ],
        {
          env: { GIT_ALLOW_PROTOCOL: "https" },
          timeoutMs: 30_000,
          maxStdoutBytes: 16 * 1024,
        },
      );
      const lines = new TextDecoder("utf-8", { fatal: true })
        .decode(result.stdout)
        .trim()
        .split(/\r?\n/);
      if (lines.length !== 2 || !/^[0-9a-f]{40}\tHEAD$/.test(lines[1] ?? "")) {
        throw new Error("remote HEAD must name an existing branch");
      }
      const ref = /^ref: (refs\/heads\/[^\s]+)\tHEAD$/.exec(lines[0] ?? "")?.[1];
      const prepared = SourceLocator.parse({ ...locator, revision: { mode: "track", ref } });
      if (prepared.kind !== "git") throw new Error("expected a Git locator");
      return prepared;
    },
    catch: (err) => {
      log().warn(
        { module: "sources/default-branch", repoUrl: locator.repoUrl, err },
        "Git default branch resolution failed",
      );
      return new DefaultBranchUnavailable({
        message: "Git repository default branch is unavailable",
      });
    },
  });
}
