// Tile installer bundles over HTTP (ADR-0034): the gstack and UI UX Pro Max
// Tiles install and uninstall through their Recipes' commands, run by a fake
// exec port from Hive's durable checkout with the homes redirected, or by a fake
// CLI on PATH where the real exec matters. A stub GitHub serves each
// repository's tarball by owner/repo.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AddSourceResult, type DeploymentOverview, type Ledger } from "@hive/contract";
import {
  buildGzipTar,
  clearHomeEnv,
  type RedirectedHome,
  redirectHomeEnv,
  type TarFixtureEntry,
} from "../../kit/__tests__/helpers.ts";
import type { ExecRequest } from "../../kit/deploy/adapter.ts";
import type { HttpFetch } from "../../kit/sync.ts";
import { createServer, type ServerHandles } from "../index.ts";
import { acceptDesiredSelection } from "./accepted-deploy-helpers.ts";

const TOKEN = "test-token";
const UIPRO_SKILLS = [
  "banner-design",
  "brand",
  "design",
  "design-system",
  "slides",
  "ui-styling",
  "ui-ux-pro-max",
];

const gstackAt = (sha: string, setup: string) => ({
  sha,
  entries: [
    { path: "top/" },
    { path: "top/SKILL.md", content: "---\nname: gstack\ndescription: Router.\n---\n" },
    { path: "top/setup", content: setup },
    { path: "top/bin/gstack-uninstall", content: "#!/usr/bin/env bash\n" },
    { path: "top/ship/SKILL.md", content: "---\nname: ship\ndescription: ship\n---\n" },
  ],
});
const GSTACK = gstackAt("a".repeat(40), "#!/usr/bin/env bash\n");

const REPOS = new Map<string, { sha: string; entries: TarFixtureEntry[] }>([
  ["garrytan/gstack", GSTACK],
  [
    "nextlevelbuilder/ui-ux-pro-max-skill",
    {
      sha: "b".repeat(40),
      entries: [
        { path: "top/" },
        {
          path: "top/.claude-plugin/marketplace.json",
          content: JSON.stringify({
            name: "ui-ux-pro-max-skill",
            plugins: [{ name: "ui-ux-pro-max", source: "./", description: "UI/UX design." }],
          }),
        },
      ],
    },
  ],
  // A kit whose bundle pointer names the gstack Tile without being its Source.
  [
    "acme/lookalike",
    {
      sha: "c".repeat(40),
      entries: [
        { path: "top/" },
        {
          path: "top/capabilities/bundles/gstack.bundle.md",
          content:
            "---\ndescription: not gstack\ninstaller:\n  kind: tile\n  tile: gstack\nsource_commit: cccc\n---\n",
        },
      ],
    },
  ],
]);

const githubFetch: HttpFetch = async (url) => {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const slug =
    parsed.hostname === "api.github.com"
      ? `${segments[1]}/${segments[2]}`
      : `${segments[0]}/${segments[1]}`;
  const repo = REPOS.get(slug);
  if (!repo) return new Response("not found", { status: 404 });
  if (parsed.hostname === "api.github.com") {
    return new Response(JSON.stringify({ sha: repo.sha }), { status: 200 });
  }
  return new Response(buildGzipTar(repo.entries), { status: 200 });
};

type Ran = ExecRequest & { home: string | undefined; codexHome: string | undefined };

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  });
}

const touch = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
};

describe("Tile installer bundles over HTTP", () => {
  let tmpRoot: string;
  let homes: RedirectedHome;
  let server: ServerHandles | undefined;
  let ran: Ran[];
  let missing: Set<string>;
  let afterUninstall: (() => Promise<void>) | null;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hive-tile-installers-"));
    homes = redirectHomeEnv(tmpRoot);
    ran = [];
    missing = new Set();
    afterUninstall = null;
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    REPOS.set("garrytan/gstack", GSTACK);
    clearHomeEnv();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  const claudeCheckout = () => join(homes.claudeHome, "skills", "gstack");
  const hiveCheckout = () => join(homes.runtimeRoot, "kit", "checkouts", "gstack");
  const gstackProofs = (home: string) => [
    join(home, "skills", "gstack", "SKILL.md"),
    join(home, "skills", "gstack-upgrade", "SKILL.md"),
  ];
  const installedPlugins = () => join(homes.claudeHome, "plugins", "installed_plugins.json");
  const operationDetails = (operationId: string | undefined) => {
    const file = JSON.parse(
      readFileSync(join(homes.runtimeRoot, "kit", "deploy-operations.json"), "utf8"),
    ) as { operations: { operationId: string; outcomes: { detail?: string }[] }[] };
    const operation = file.operations.find((candidate) => candidate.operationId === operationId);
    return operation?.outcomes.map((outcome) => outcome.detail) ?? [];
  };

  // Does what each real command does to the redirected homes.
  async function fakeExec(request: ExecRequest, env: NodeJS.ProcessEnv) {
    ran.push({ ...request, home: env.HOME, codexHome: env.CODEX_HOME });
    const args = request.args.join(" ");
    if (request.command.endsWith("/setup")) {
      const home = args.includes("--host claude") ? homes.claudeHome : homes.codexHome;
      for (const proof of gstackProofs(home)) touch(proof);
    } else if (request.command.endsWith("/bin/gstack-uninstall")) {
      rmSync(claudeCheckout(), { recursive: true, force: true });
      for (const home of [homes.claudeHome, homes.codexHome]) {
        for (const skill of ["gstack", "gstack-upgrade"]) {
          if (home === homes.claudeHome && skill === "gstack") continue;
          rmSync(join(home, "skills", skill), { recursive: true, force: true });
        }
      }
      await afterUninstall?.();
    } else if (request.command === "npx" && args.includes("init")) {
      for (const skill of UIPRO_SKILLS) touch(join(homes.agentsHome, "skills", skill, "SKILL.md"));
    } else if (request.command === "npx" && args.includes("uninstall") && request.stdin === "y\n") {
      for (const skill of UIPRO_SKILLS) {
        rmSync(join(homes.agentsHome, "skills", skill), { recursive: true, force: true });
      }
    } else if (request.command === "claude" && request.args[1] === "install") {
      touch(installedPlugins());
      writeFileSync(
        installedPlugins(),
        JSON.stringify({ plugins: { "ui-ux-pro-max@ui-ux-pro-max-skill": [{}] } }),
      );
    } else if (request.command === "claude" && request.args[1] === "uninstall") {
      writeFileSync(installedPlugins(), '{"plugins":{}}');
    }
    return { status: 0, stdout: "", stderr: "" };
  }

  async function start(): Promise<ServerHandles> {
    server = await createServer({
      mode: "memory",
      token: TOKEN,
      fetch: githubFetch,
      exec: fakeExec,
      probe: async (name) => !missing.has(name),
    });
    return server;
  }

  async function add(api: ServerHandles, body: unknown) {
    const res = await api.app.fetch(
      authed("/api/sources", { method: "POST", body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(201);
    return AddSourceResult.parse(await res.json());
  }

  const gstack = (targets: ("claude" | "codex")[]) =>
    targets.length > 0 ? [{ key: { kind: "bundle", name: "gstack" } as const, targets }] : [];

  const row = (overview: DeploymentOverview, kind: string, name: string) =>
    overview.rows.find((candidate) => candidate.key.kind === kind && candidate.key.name === name);

  const commands = () =>
    ran.map((request) => [request.command.replace(tmpRoot, "<root>"), ...request.args].join(" "));

  test("installs gstack by running setup for each CLI from the durable checkout with HOME redirected", async () => {
    const api = await start();
    await add(api, { tile: "gstack" });
    const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));

    expect(overview.lastOperation?.state).toBe("completed");
    expect(row(overview, "bundle", "gstack")?.targets).toMatchObject([
      { target: "claude", reconciliation: "in_sync", observation: "verified" },
      { target: "codex", reconciliation: "in_sync", observation: "verified" },
    ]);
    const checkout = claudeCheckout();
    expect(commands()).toEqual([
      "<root>/homes/.claude/skills/gstack/setup --host claude -q",
      "<root>/homes/.claude/skills/gstack/setup --host codex -q",
    ]);
    for (const request of ran) {
      expect(request.cwd).toBe(checkout);
      expect(request.home).toBe(join(tmpRoot, "homes"));
      expect(request.codexHome).toBe(homes.codexHome);
    }
    expect(readFileSync(join(checkout, "setup"), "utf8")).toBe("#!/usr/bin/env bash\n");
    expect(existsSync(join(checkout, ".git"))).toBe(false);
    expect(existsSync(hiveCheckout())).toBe(false);
  });

  const backupOf = (operationId: string | undefined) =>
    operationDetails(operationId)
      .find((detail) => detail?.startsWith("moved a folder Hive did not create to "))
      ?.replace("moved a folder Hive did not create to ", "") ?? "";

  test("a gstack checkout Hive did not create moves to Hive's backups, outside every skills folder", async () => {
    const api = await start();
    await add(api, { tile: "gstack" });
    const mine = claudeCheckout();
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "notes.md"), "my own clone\n");

    const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude"]));

    expect(overview.lastOperation?.state).toBe("completed");
    expect(readdirSync(join(homes.claudeHome, "skills")).sort()).toEqual([
      "gstack",
      "gstack-upgrade",
    ]);
    const backup = backupOf(overview.lastOperation?.operationId);
    expect(dirname(backup)).toBe(join(homes.runtimeRoot, "kit", "backups"));
    expect(basename(backup)).toStartWith("gstack-");
    expect(readFileSync(join(backup, "notes.md"), "utf8")).toBe("my own clone\n");
    expect(readFileSync(join(mine, "setup"), "utf8")).toBe("#!/usr/bin/env bash\n");

    const again = await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));
    expect(again.lastOperation?.state).toBe("completed");
    expect(readFileSync(join(backup, "notes.md"), "utf8")).toBe("my own clone\n");
  });

  test("a second foreign gstack checkout gets its own backup and leaves the first one", async () => {
    const api = await start();
    await add(api, { tile: "gstack" });
    const backups: string[] = [];
    for (const text of ["first clone\n", "second clone\n"]) {
      mkdirSync(claudeCheckout(), { recursive: true });
      writeFileSync(join(claudeCheckout(), "notes.md"), text);
      const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude"]));
      expect(overview.lastOperation?.state).toBe("completed");
      backups.push(backupOf(overview.lastOperation?.operationId));
      await acceptDesiredSelection(api, TOKEN, gstack([]));
    }

    expect(new Set(backups).size).toBe(2);
    expect(backups.map((backup) => readFileSync(join(backup, "notes.md"), "utf8"))).toEqual([
      "first clone\n",
      "second clone\n",
    ]);
  });

  test("a Sync between gstack-uninstall and the reinstall leaves the reinstall at the planned commit", async () => {
    const api = await start();
    await add(api, { tile: "gstack" });
    await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));
    REPOS.set("garrytan/gstack", gstackAt("d".repeat(40), "#!/usr/bin/env bash\n# moved on\n"));
    const synced: unknown[] = [];
    afterUninstall = async () => {
      const res = await api.app.fetch(authed("/api/kit/sync", { method: "POST" }));
      synced.push(await res.json());
    };

    const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude"]));

    expect(synced).toMatchObject([{ sources: [{ status: "synced" }] }]);
    expect(overview.lastOperation?.state).toBe("completed");
    expect(commands()).toContain("<root>/homes/.claude/skills/gstack/setup --host claude -q");
    expect(readFileSync(join(claudeCheckout(), "setup"), "utf8")).toBe("#!/usr/bin/env bash\n");
    expect(readFileSync(join(claudeCheckout(), ".hive-checkout"), "utf8")).toBe(
      `${"a".repeat(40)}\n`,
    );
    expect(readdirSync(join(homes.runtimeRoot, "kit", "tmp"))).toEqual([]);
  });

  test("deleting the gstack Source between gstack-uninstall and the reinstall still reinstalls Claude", async () => {
    const api = await start();
    const added = await add(api, { tile: "gstack" });
    await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));
    afterUninstall = async () => {
      const res = await api.app.fetch(
        authed(`/api/sources/${added.source.id}`, { method: "DELETE" }),
      );
      expect(res.status).toBe(204);
    };

    const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude"]));

    expect(overview.lastOperation?.state).toBe("completed");
    for (const proof of gstackProofs(homes.claudeHome)) expect(existsSync(proof)).toBe(true);
    expect(readFileSync(join(claudeCheckout(), "setup"), "utf8")).toBe("#!/usr/bin/env bash\n");
  });

  test("removing Codex runs gstack-uninstall once, then reinstalls the kept Claude", async () => {
    const api = await start();
    await add(api, { tile: "gstack" });
    await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));
    ran = [];

    const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude"]));

    expect(overview.lastOperation?.state).toBe("completed");
    expect(commands()).toEqual([
      "<root>/homes/.claude/skills/gstack/bin/gstack-uninstall --force",
      "<root>/homes/.claude/skills/gstack/setup --host claude -q",
    ]);
    for (const proof of gstackProofs(homes.claudeHome)) expect(existsSync(proof)).toBe(true);
    for (const proof of gstackProofs(homes.codexHome)) expect(existsSync(proof)).toBe(false);
  });

  test("removing every CLI leaves no checkout", async () => {
    const api = await start();
    await add(api, { tile: "gstack" });
    await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));
    await acceptDesiredSelection(api, TOKEN, gstack([]));
    expect(existsSync(claudeCheckout())).toBe(false);

    // A Codex-only install runs from a Hive-owned checkout, which the removal deletes.
    ran = [];
    await acceptDesiredSelection(api, TOKEN, gstack(["codex"]));
    expect(ran.map((request) => request.cwd)).toEqual([hiveCheckout()]);
    const removed = await acceptDesiredSelection(api, TOKEN, gstack([]));
    expect(removed.lastOperation?.state).toBe("completed");
    expect(commands().at(-1)).toBe(
      "<root>/runtime/kit/checkouts/gstack/bin/gstack-uninstall --force",
    );
    expect(existsSync(hiveCheckout())).toBe(false);
    expect(existsSync(claudeCheckout())).toBe(false);
  });

  test("a missing bun fails with missing_binary before anything runs or is copied", async () => {
    missing.add("bun");
    const api = await start();
    await add(api, { tile: "gstack" });
    const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));

    expect(overview.lastOperation?.state).toBe("failed");
    expect(
      row(overview, "bundle", "gstack")?.targets.map((target) => target.lastAttempt),
    ).toMatchObject([
      { state: "failed", code: "missing_binary" },
      { state: "failed", code: "missing_binary" },
    ]);
    expect(ran).toEqual([]);
    expect(existsSync(claudeCheckout())).toBe(false);
  });

  test("a look-alike pointer naming the gstack Tile in another kit stays a manual install", async () => {
    const api = await start();
    await add(api, {
      label: "Look-alike",
      locator: {
        kind: "git",
        repoUrl: "https://github.com/acme/lookalike",
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
    });
    const overview = await acceptDesiredSelection(api, TOKEN, gstack(["claude", "codex"]));

    expect(overview.diff.entries).toEqual([]);
    expect(row(overview, "bundle", "gstack")?.reconciliation).toBe("manual_install_required");
    expect(ran).toEqual([]);
  });

  // The fake claude blocks in `plugin install` until the API has answered while
  // it runs, or 3 s pass. A synchronous spawn would freeze the event loop for
  // that whole time, so no overview could arrive while it ran.
  test.skipIf(process.platform === "win32")(
    "the API answers over HTTP while an installer is still running",
    async () => {
      const bin = join(tmpRoot, "bin");
      const started = join(tmpRoot, "install-started");
      const answered = join(tmpRoot, "api-answered");
      const finished = join(tmpRoot, "install-finished");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "claude"),
        [
          "#!/bin/sh",
          '[ "$1" = "--version" ] && exit 0',
          '[ "$1 $2" = "plugin install" ] || exit 0',
          `: > '${started}'`,
          "waited=0",
          `while [ ! -e '${answered}' ] && [ "$waited" -lt 300 ]; do sleep 0.01; waited=$((waited + 1)); done`,
          'mkdir -p "$CLAUDE_CONFIG_DIR/plugins"',
          `printf '%s' '{"plugins":{"ui-ux-pro-max@ui-ux-pro-max-skill":[{}]}}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"`,
          `: > '${finished}'`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const inheritedPath = process.env.PATH;
      process.env.PATH = `${bin}:${inheritedPath ?? ""}`;
      const api = await createServer({ mode: "memory", token: TOKEN, fetch: githubFetch });
      server = api;
      const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.app.fetch });
      try {
        await add(api, { tile: "ui-ux-pro-max" });
        let settled = false;
        const deployed = acceptDesiredSelection(api, TOKEN, [
          { key: { kind: "plugin", name: "ui-ux-pro-max" }, targets: ["claude"] },
        ]).finally(() => {
          settled = true;
        });
        let answeredWhileInstalling = 0;
        while (!settled) {
          const response = await fetch(`http://127.0.0.1:${listener.port}/api/kit/overview`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          });
          expect(response.status).toBe(200);
          await response.arrayBuffer();
          if (existsSync(started) && !existsSync(finished)) {
            answeredWhileInstalling++;
            writeFileSync(answered, "");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const overview = await deployed;

        expect(answeredWhileInstalling).toBeGreaterThan(0);
        expect(overview.lastOperation?.state).toBe("completed");
        expect(row(overview, "plugin", "ui-ux-pro-max")?.reconciliation).toBe("in_sync");
      } finally {
        listener.stop(true);
        process.env.PATH = inheritedPath;
      }
    },
  );

  test("UI UX Pro Max installs its Claude plugin and its Codex skills, and uninstalls both", async () => {
    const api = await start();
    await add(api, { tile: "ui-ux-pro-max" });
    const both = ["claude", "codex"] as ("claude" | "codex")[];
    const installed = await acceptDesiredSelection(api, TOKEN, [
      { key: { kind: "plugin", name: "ui-ux-pro-max" }, targets: both },
      { key: { kind: "bundle", name: "ui-ux-pro-max" }, targets: both },
    ]);

    expect(installed.lastOperation?.state).toBe("completed");
    expect(row(installed, "plugin", "ui-ux-pro-max")?.applicableTargets).toEqual(["claude"]);
    expect(row(installed, "bundle", "ui-ux-pro-max")?.applicableTargets).toEqual(["codex"]);
    expect(row(installed, "plugin", "ui-ux-pro-max")?.reconciliation).toBe("in_sync");
    expect(row(installed, "bundle", "ui-ux-pro-max")?.reconciliation).toBe("in_sync");
    expect(commands()).toContain(
      "claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill --scope user",
    );
    const init = ran.find((request) => request.args.includes("init"));
    expect(init).toMatchObject({
      command: "npx",
      args: ["-y", "ui-ux-pro-max-cli", "init", "--ai", "codex", "--global"],
      cwd: join(tmpRoot, "homes"),
    });
    expect(init?.stdin).toBeUndefined();
    for (const skill of UIPRO_SKILLS) {
      expect(existsSync(join(homes.agentsHome, "skills", skill, "SKILL.md"))).toBe(true);
    }
    // A Tile install is Hive's own; the agent-kit Ledger lists only the plugin.
    const ledger = JSON.parse(readFileSync(homes.ledgerPath, "utf8")) as Ledger;
    expect(ledger.bundles).toEqual([]);

    ran = [];
    const removed = await acceptDesiredSelection(api, TOKEN, []);
    expect(removed.lastOperation?.state).toBe("completed");
    expect(ran.map(({ command, args, stdin }) => ({ command, args, stdin }))).toEqual([
      {
        command: "claude",
        args: ["plugin", "uninstall", "ui-ux-pro-max@ui-ux-pro-max-skill", "--scope", "user"],
        stdin: undefined,
      },
      {
        command: "npx",
        args: ["-y", "ui-ux-pro-max-cli", "uninstall", "--ai", "codex", "--global"],
        stdin: "y\n",
      },
    ]);
    for (const skill of UIPRO_SKILLS) {
      expect(existsSync(join(homes.agentsHome, "skills", skill))).toBe(false);
    }
    expect(row(removed, "bundle", "ui-ux-pro-max")?.targets).toMatchObject([
      { target: "codex", desired: "off", reconciliation: "in_sync", observation: "missing" },
    ]);
  });
});
