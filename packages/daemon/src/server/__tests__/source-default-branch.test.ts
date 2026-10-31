import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      `#!${process.execPath}
const args = Bun.argv.slice(2).map(arg => arg.startsWith("https://") ? (arg.includes("unreachable") ? ${JSON.stringify(join(root, "missing"))} : ${JSON.stringify(repo)}) : arg);
const child = Bun.spawn([${JSON.stringify(realGit)}, "-c", "protocol.file.allow=always", ...args], {
  env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" }, stdin: "inherit", stdout: "pipe", stderr: "pipe",
});
await Promise.all([Bun.write(Bun.stdout, child.stdout), Bun.write(Bun.stderr, child.stderr)]);
process.exit(await child.exited);
`,
    );
    chmodSync(shim, 0o755);
    originalPath = process.env.PATH;
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
    expect(result.sync.state).toBe("up_to_date");
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
    expect(result.source.label).toBe("HyperFrames");
    const shelf = TileSummary.array().parse(await (await request("/api/tiles")).json());
    expect(shelf.find((tile) => tile.id === "hyperframes")?.sourceId).toBe(result.source.id);
    const overview = DeploymentOverview.parse(await (await request("/api/kit/overview")).json());
    expect(overview.sources.find((source) => source.id === result.source.id)?.recipe.unit).toBe(
      "whole",
    );
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
