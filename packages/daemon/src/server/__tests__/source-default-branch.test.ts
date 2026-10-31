import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AddSourceResult,
  Catalog,
  DeploymentOverview,
  SyncRunResult,
  TileSummary,
} from "@hive/contract";
import { clearHomeEnv, redirectHomeEnv } from "../../kit/__tests__/helpers.ts";
import { SourcesFileSchema } from "../../sources/types.ts";
import { createServer, type ServerHandles } from "../index.ts";

const TOKEN = "test-token";
const URL = "https://fixture.invalid/owner/kit";

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe.skipIf(process.platform === "win32")("pasted repository default branch over HTTP", () => {
  let root: string;
  let runtimeRoot: string;
  let repo: string;
  let originalPath: string | undefined;
  let realGit: string;
  let server: ServerHandles | undefined;

  function git(...args: string[]): string {
    const result = Bun.spawnSync([realGit, "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  beforeEach(() => {
    originalPath = process.env.PATH;
    root = mkdtempSync(join(tmpdir(), "hive-default-branch-"));
    runtimeRoot = redirectHomeEnv(root).runtimeRoot;
    repo = join(root, "repo");
    mkdirSync(repo);
    const binary = Bun.which("git");
    if (!binary) throw new Error("git is required for the local fixture");
    realGit = binary;
    git("init", "-b", "master");
    git("config", "user.name", "Hive Test");
    git("config", "user.email", "hive@example.invalid");
    git("config", "uploadpack.allowFilter", "true");
    mkdirSync(join(repo, "skills", "fixture"), { recursive: true });
    writeFileSync(
      join(repo, "skills", "fixture", "SKILL.md"),
      "---\nname: fixture\ndescription: local fixture\n---\nmaster body\n",
    );
    git("add", ".");
    git("commit", "-m", "fixture");

    const bin = join(root, "bin");
    mkdirSync(bin);
    const shim = join(bin, "git");
    writeFileSync(
      shim,
      `#!/bin/bash
fixture_args=()
for fixture_arg in "$@"; do
  case "$fixture_arg" in
    https://*unreachable*) fixture_arg=${shellLiteral(join(root, "missing"))} ;;
    https://*) fixture_arg=${shellLiteral(repo)} ;;
  esac
  fixture_args+=("$fixture_arg")
done
if [[ " \${fixture_args[*]} " == *" ls-remote "* ]]; then
  printf '%s\n' "$GIT_TERMINAL_PROMPT" >> ${shellLiteral(join(root, "lookup-prompts"))}
  if [[ -f ${shellLiteral(join(root, "advertisement"))} ]]; then
    cat ${shellLiteral(join(root, "advertisement"))}
    exit 0
  fi
fi
export GIT_ALLOW_PROTOCOL=file
export PATH=${shellLiteral(originalPath ?? "")}
cd ${shellLiteral(repo)}
exec ${shellLiteral(realGit)} -c protocol.file.allow=always "\${fixture_args[@]}"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    clearHomeEnv();
    rmSync(root, { recursive: true, force: true });
  });

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!server) server = await createServer({ mode: "file", token: TOKEN });
    return server.app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      }),
    );
  }

  function add(repoUrl = URL) {
    return request("/api/sources", {
      method: "POST",
      body: JSON.stringify({
        label: "Pasted",
        locator: {
          kind: "git",
          repoUrl,
          revision: { mode: "track", ref: "HEAD" },
          subpath: ".",
        },
      }),
    });
  }

  test("stores and syncs master without main, then keeps the branch chosen at Add", async () => {
    expect(git("branch", "--list", "main")).toBe("");
    const response = await add();
    expect(response.status).toBe(201);
    const result = AddSourceResult.parse(await response.json());
    expect(result.sync).toMatchObject({ state: "up_to_date" });
    expect(readFileSync(join(root, "lookup-prompts"), "utf8")).toBe("0\n");
    const registry = SourcesFileSchema.parse(
      JSON.parse(readFileSync(join(runtimeRoot, "sources.json"), "utf8")),
    );
    expect(registry.sources[0]?.locator).toEqual({
      kind: "git",
      repoUrl: URL,
      revision: { mode: "track", ref: "refs/heads/master" },
      subpath: ".",
    });
    const before = Catalog.parse(await (await request("/api/kit/catalog")).json());
    git("switch", "-c", "trunk");
    writeFileSync(
      join(repo, "skills", "fixture", "SKILL.md"),
      "---\nname: fixture\ndescription: local fixture\n---\ntrunk body\n",
    );
    git("add", ".");
    git("commit", "-m", "new default");
    const sync = SyncRunResult.parse(
      await (await request("/api/kit/sync", { method: "POST" })).json(),
    );
    expect(sync.sources[0]?.status).toBe("unchanged");
    expect(Catalog.parse(await (await request("/api/kit/catalog")).json())).toEqual(before);
  });

  test("resolves a pasted Tile URL to its existing identity and Recipe", async () => {
    git("branch", "-m", "main");
    const response = await add("https://github.com/heygen-com/hyperframes.git");
    expect(response.status).toBe(201);
    const result = AddSourceResult.parse(await response.json());
    expect(result.sync).toMatchObject({ state: "up_to_date" });
    expect(result.source.label).toBe("HyperFrames");
    const shelf = TileSummary.array().parse(await (await request("/api/tiles")).json());
    expect(shelf.find((tile) => tile.id === "hyperframes")?.sourceId).toBe(result.source.id);
    const overview = DeploymentOverview.parse(await (await request("/api/kit/overview")).json());
    expect(overview.sources.find((source) => source.id === result.source.id)?.recipe?.unit).toBe(
      "whole",
    );
  });

  test("keeps explicit branches and pins without looking up the default branch", async () => {
    for (const revision of [
      { mode: "track", ref: "refs/heads/master" },
      { mode: "pin", commit: git("rev-parse", "HEAD") },
    ]) {
      const response = await request("/api/sources", {
        method: "POST",
        body: JSON.stringify({
          label: "Explicit",
          locator: {
            kind: "git",
            repoUrl: URL,
            revision,
            subpath: ".",
          },
        }),
      });
      expect(response.status).toBe(201);
      expect(AddSourceResult.parse(await response.json()).sync.state).toBe("up_to_date");
    }
    expect(existsSync(join(root, "lookup-prompts"))).toBe(false);
  });

  test("rejects malformed, missing, or non-branch remote HEAD advertisements", async () => {
    const sha = git("rev-parse", "HEAD");
    for (const stdout of [
      "",
      `${sha}\tHEAD\n`,
      "ref: refs/heads/master\tHEAD\n",
      `ref: refs/tags/v1\tHEAD\n${sha}\tHEAD\n`,
      `ref: refs/heads/master~1\tHEAD\n${sha}\tHEAD\n`,
      `ref: refs/heads/mäin\tHEAD\n${sha}\tHEAD\n`,
      `ref: refs/heads/master\tHEAD\ninvalid-commit\tHEAD\n`,
      `ref: refs/heads/master\tHEAD\n${sha}\tHEAD\n${sha}\tHEAD\n`,
    ]) {
      writeFileSync(join(root, "advertisement"), stdout);
      const response = await add();
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid source",
        issues: [
          { path: "locator.repoUrl", message: "Git repository default branch is unavailable" },
        ],
      });
    }
    expect(await (await request("/api/sources")).json()).toEqual([]);
  });

  test("reports an unreachable Git default branch on its URL field and keeps the registry empty", async () => {
    const response = await add("https://fixture.invalid/unreachable/kit");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid source",
      issues: [
        { path: "locator.repoUrl", message: "Git repository default branch is unavailable" },
      ],
    });
    expect(await (await request("/api/sources")).json()).toEqual([]);
  });
});
