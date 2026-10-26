#!/usr/bin/env bun
// The Tiles end-to-end lever (ADR-0033, ADR-0034). Starts a daemon in a fresh
// sandbox (HOME, the runtime root, and every deploy-target home inside it),
// drives it only through its HTTP API, checks what lands in the sandbox homes,
// and prints a pass/fail table:
//   1. adds each Tile: sync state, Recipe, capability count, and its shelf entry;
//   2. pastes two links that are no Tile's: one a generic Recipe recognizes, one
//      no Recipe recognizes;
//   3. selects the Tiles' Capabilities on Claude Code and Codex, deploys, and
//      checks the Overview, the files, the plugin records, the Ledger, and
//      `codex debug prompt-input`;
//   4. deselects everything, deploys, and checks every artifact is gone.
// The real homes that a Deploy writes are hashed before and after, and must not change.
//
//   bun run packages/daemon/scripts/tiles-e2e.ts [--tiles a,b] [--skip a,b]
//     [--existing-codex-home] [--keep]
//
// Default: every Tile but gstack, whose setup downloads Bun packages and a
// Chromium build. --skip replaces that default; a Tile named in --tiles is
// never skipped by default. The Codex home starts absent, as for a user who
// never ran Codex; --existing-codex-home creates it empty first, as Codex does on
// its first run. --keep leaves the sandbox for inspection.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { type CapabilityKey, serializeCapabilityKey } from "@hive/capability-schema";
import {
  AcceptedDeployResponse,
  AddSourceResult,
  DeploymentOverview,
  type DeployTarget,
  KitStateSchema,
  type Ledger,
  SelectionSnapshot,
  SourceSummary,
  TileSummary,
} from "@hive/contract";
import { z } from "zod";
import { TILES } from "../src/kit/recipes/tiles.ts";

const USAGE = "usage: tiles-e2e [--tiles a,b] [--skip a,b] [--existing-codex-home] [--keep]";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BOTH: DeployTarget[] = ["claude", "codex"];
// Sync reasons the devbox's per-repository git rate limit produces.
const RETRYABLE = new Set(["io", "auth_or_repository_unavailable"]);
const RETRY_WAIT_MS = 65_000;
const DEPLOY_TIMEOUT_MS = 30 * 60_000;

const PASTED_RECOGNIZED = "https://github.com/anthropics/skills";
const PASTED_UNRECOGNIZED = "https://github.com/github/gitignore";
const GENERIC_RECIPES = new Set([
  "capability-kit",
  "plugin-marketplace",
  "published-skills",
  "single-cli-marketplace",
]);
const HYPERFRAMES_SKILLS = 7;
const UIPRO_CODEX_SKILLS = [
  "banner-design",
  "brand",
  "design",
  "design-system",
  "slides",
  "ui-styling",
  "ui-ux-pro-max",
];

// ---- arguments ----

type Args = { tiles: string[]; keep: boolean; existingCodexHome: boolean };

function parseArgs(argv: readonly string[]): Args | string {
  const known = TILES.map((tile) => tile.id);
  let named: string[] | null = null;
  let skip: string[] | null = null;
  let keep = false;
  let existingCodexHome = false;
  const list = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--keep") keep = true;
    else if (arg === "--existing-codex-home") existingCodexHome = true;
    else if (arg === "--tiles") named = list(argv[++index]);
    else if (arg === "--skip") skip = list(argv[++index]);
    else return `unknown argument ${arg}`;
  }
  const unknown = [...(named ?? []), ...(skip ?? [])].filter((id) => !known.includes(id));
  if (unknown.length > 0) return `unknown Tile ${unknown.join(", ")} (${known.join(", ")})`;
  const skipped = skip ?? (named ? [] : ["gstack"]);
  const tiles = (named ?? known).filter((id) => !skipped.includes(id));
  return tiles.length > 0 ? { tiles, keep, existingCodexHome } : "no Tile left to check";
}

// ---- the result table ----

type Row = { step: string; check: string; ok: boolean; ms: number; detail: string };
const rows: Row[] = [];
const stepTimes: { step: string; ms: number }[] = [];

function record(step: string, check: string, ok: boolean, ms: number, text: string): void {
  const detail = text.replace(/\s+/g, " ").trim();
  rows.push({ step, check, ok, ms, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${step}  ${check}  ${detail}`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function printTable(): void {
  const header = { step: "step", check: "check", result: "result", time: "time" };
  const lines = rows.map((row) => ({
    step: row.step,
    check: row.check,
    result: row.ok ? "PASS" : "FAIL",
    time: seconds(row.ms),
    detail: row.detail,
  }));
  const width = (key: "step" | "check" | "result" | "time") =>
    Math.max(header[key].length, ...lines.map((line) => line[key].length));
  const [w1, w2, w3, w4] = [width("step"), width("check"), width("result"), width("time")];
  const format = (line: { step: string; check: string; result: string; time: string }) =>
    `${line.step.padEnd(w1)}  ${line.check.padEnd(w2)}  ${line.result.padEnd(w3)}  ${line.time.padStart(w4)}`;
  console.log(`${format(header)}  detail`);
  for (const line of lines) console.log(`${format(line)}  ${line.detail}`);
  console.log("\nstep timings");
  const stepWidth = Math.max(...stepTimes.map((entry) => entry.step.length));
  for (const entry of stepTimes) {
    console.log(`  ${entry.step.padEnd(stepWidth)}  ${seconds(entry.ms).padStart(w4)}`);
  }
  const failed = rows.filter((row) => !row.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} checks passed`);
}

// ---- the sandbox ----

type Sandbox = {
  root: string;
  home: string;
  runtime: string;
  claudeHome: string;
  codexHome: string;
  agentsHome: string;
  ledgerPath: string;
  // The HOME the daemon gives installers: the homes' common parent.
  homesParent: string;
  tmp: string;
};

function createSandbox(existingCodexHome: boolean): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "hive-tiles-e2e-"));
  const home = join(root, "home");
  const runtime = join(home, ".hive");
  const homesParent = join(runtime, "homes");
  const sandbox: Sandbox = {
    root,
    home,
    runtime,
    homesParent,
    claudeHome: join(homesParent, ".claude"),
    codexHome: join(homesParent, ".codex"),
    agentsHome: join(homesParent, ".agents"),
    ledgerPath: join(homesParent, ".agent-kit", "manifest.json"),
    tmp: join(root, "tmp"),
  };
  for (const dir of [home, runtime, homesParent, sandbox.tmp]) mkdirSync(dir, { recursive: true });
  if (existingCodexHome) mkdirSync(sandbox.codexHome);
  // npm and bun reach the configured registry only through ~/.npmrc. Copy the
  // registry lines, never credentials.
  const npmrc = join(homedir(), ".npmrc");
  if (existsSync(npmrc)) {
    const lines = readFileSync(npmrc, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("registry="));
    if (lines.length > 0) writeFileSync(join(home, ".npmrc"), `${lines.join("\n")}\n`);
  }
  return sandbox;
}

// The real paths a Deploy would write. Hashing them before and after proves
// the run never reached them.
const REAL_GUARDED = [
  ".claude/skills",
  ".claude/plugins/installed_plugins.json",
  ".codex/skills",
  ".codex/config.toml",
  ".agents",
  ".agent-kit",
  ".gstack",
];

function treeDigest(path: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, rel: string): void => {
    if (!existsSync(current) && !isLink(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) hash.update(`L ${rel} ${readlinkSync(current)}\n`);
    else if (stat.isDirectory()) {
      hash.update(`D ${rel}\n`);
      for (const name of readdirSync(current).sort()) walk(join(current, name), `${rel}/${name}`);
    } else if (stat.isFile()) {
      hash.update(`F ${rel} ${stat.mode & 0o777} `);
      hash.update(readFileSync(current));
      hash.update("\n");
    }
  };
  walk(path, ".");
  return hash.digest("hex");
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function realHomeDigests(): Map<string, string> {
  return new Map(REAL_GUARDED.map((rel) => [rel, treeDigest(join(homedir(), rel))] as const));
}

// ---- the daemon ----

type Reply = { status: number; body: unknown };

class Daemon {
  constructor(
    readonly base: string,
    readonly token: string,
  ) {}

  async call(method: string, path: string, body?: unknown, timeoutMs = 900_000): Promise<Reply> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: parsed };
  }

  async read<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    return expectBody(schema, await this.call("GET", path), 200, `GET ${path}`);
  }
}

function expectBody<T>(schema: z.ZodType<T>, reply: Reply, status: number, what: string): T {
  if (reply.status !== status) {
    throw new Error(
      `${what} answered ${reply.status}: ${JSON.stringify(reply.body).slice(0, 300)}`,
    );
  }
  const parsed = schema.safeParse(reply.body);
  if (!parsed.success) {
    throw new Error(`${what} body does not parse: ${parsed.error.issues[0]?.message ?? "?"}`);
  }
  return parsed.data;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

async function startDaemon(sandbox: Sandbox): Promise<{ daemon: Daemon; child: ChildProcess }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: sandbox.home,
    TMPDIR: sandbox.tmp,
    LANG: process.env.LANG ?? "C.UTF-8",
    USER: process.env.USER,
    HIVE_PORT: String(port),
    HIVE_RUNTIME_ROOT: sandbox.runtime,
    HIVE_CLAUDE_HOME: sandbox.claudeHome,
    HIVE_CODEX_HOME: sandbox.codexHome,
    HIVE_AGENTS_HOME: sandbox.agentsHome,
    HIVE_LEDGER_PATH: sandbox.ledgerPath,
  };
  const out = openSync(join(sandbox.root, "daemon.out"), "a");
  const child = spawn("bun", ["run", "packages/daemon/src/server/start.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", out, out],
    detached: true,
  });
  closeSync(out);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const token = readFileSync(join(sandbox.runtime, ".token"), "utf8").trim();
        return { daemon: new Daemon(base, token), child };
      }
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("daemon not ready after 60s");
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  const group = -child.pid;
  try {
    process.kill(group, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await Bun.sleep(250);
  try {
    process.kill(group, "SIGKILL");
  } catch {}
}

// ---- Source helpers ----

const TileShelf = z.array(TileSummary);
const SourceList = z.array(SourceSummary);
const KitState = KitStateSchema;
type Added = { sourceId: string; result: AddSourceResult; retried: boolean };

// Adds a Source once, and once more after the rate limit refills when Sync
// failed the way the devbox's git rate limit fails it.
async function addSource(daemon: Daemon, body: unknown, what: string): Promise<Added> {
  let retried = false;
  for (;;) {
    const reply = await daemon.call("POST", "/api/sources", body);
    const result = expectBody(AddSourceResult, reply, 201, `POST /api/sources ${what}`);
    const reason = result.sync.errorReason ?? "";
    if (result.sync.state === "up_to_date" || result.sync.state === "local") {
      return { sourceId: result.source.id, result, retried };
    }
    if (retried || !RETRYABLE.has(reason)) return { sourceId: result.source.id, result, retried };
    console.error(`  ${what}: sync ${reason}; retrying in ${RETRY_WAIT_MS / 1000}s`);
    await deleteSource(daemon, result.source.id);
    await Bun.sleep(RETRY_WAIT_MS);
    retried = true;
  }
}

async function deleteSource(daemon: Daemon, id: string): Promise<void> {
  const reply = await daemon.call("DELETE", `/api/sources/${id}`);
  if (reply.status !== 204) throw new Error(`DELETE /api/sources/${id} answered ${reply.status}`);
}

async function overview(daemon: Daemon): Promise<DeploymentOverview> {
  for (let attempt = 0; ; attempt++) {
    const reply = await daemon.call("GET", "/api/kit/overview", undefined, 60_000);
    if (reply.status === 409 && attempt < 10) {
      await Bun.sleep(500);
      continue;
    }
    return expectBody(DeploymentOverview, reply, 200, "GET /api/kit/overview");
  }
}

function syncText(result: AddSourceResult): string {
  const { sync } = result;
  if (sync.state === "up_to_date" || sync.state === "local") {
    return `sync=${sync.state}${sync.sha ? ` sha=${sync.sha.slice(0, 7)}` : ""}`;
  }
  return `sync=${sync.state} ${sync.errorReason ?? ""}${sync.errorDetail ? `: ${sync.errorDetail}` : ""}`;
}

// ---- step 1: the shelf ----

async function addTiles(daemon: Daemon, ids: readonly string[]): Promise<Map<string, string>> {
  const sourceByTile = new Map<string, string>();
  const shelf = await daemon.read(TileShelf, "/api/tiles");
  for (const id of ids) {
    const step = "1 add Tile";
    const start = performance.now();
    try {
      const tile = shelf.find((entry) => entry.id === id);
      if (!tile) throw new Error(`GET /api/tiles does not list ${id}`);
      const added = await addSource(daemon, { tile: id }, id);
      const result = added.result;
      const sourceId = result.source.id;
      const sync = syncText(result);
      const syncOk = result.sync.state === "up_to_date";
      let caps: number | null = result.validation.capabilityCount;
      const retried = added.retried;
      sourceByTile.set(id, sourceId);
      const view = await overview(daemon);
      const recipe = view.sources.find((source) => source.id === sourceId)?.recipe ?? null;
      if (caps === null) {
        caps = view.variants.filter((entry) => entry.sourceIds.includes(sourceId)).length;
      }
      const after = (await daemon.read(TileShelf, "/api/tiles")).find((t) => t.id === id);
      const recipeOk = recipe?.id === tile.recipe.id && recipe.unit === tile.recipe.unit;
      const shelfOk = after?.sourceId === sourceId;
      const ok = syncOk && recipeOk && shelfOk && caps > 0;
      record(
        step,
        id,
        ok,
        Math.round(performance.now() - start),
        `${sync} ${recipe ? `${recipe.id}/${recipe.unit}` : "no Recipe"}${recipeOk ? "" : ` (Tile: ${tile.recipe.id}/${tile.recipe.unit})`} caps=${caps} shelf=${shelfOk ? "ok" : String(after?.sourceId)}${retried ? " [retried once]" : ""}`,
      );
    } catch (error) {
      record(step, id, false, Math.round(performance.now() - start), errorText(error));
    }
  }
  return sourceByTile;
}

// ---- step 2: pasted links ----

function pastedBody(url: string) {
  return {
    label: new URL(url).pathname.slice(1),
    locator: {
      kind: "git",
      repoUrl: url,
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    },
  };
}

// Each pasted Source is deleted after its check: it would merge with or shadow
// the Tiles' Capabilities in step 3.
async function pasteLinks(daemon: Daemon, sandbox: Sandbox): Promise<void> {
  for (const url of [PASTED_RECOGNIZED, PASTED_UNRECOGNIZED]) {
    const expectRecognized = url === PASTED_RECOGNIZED;
    const start = performance.now();
    try {
      const added = await addSource(daemon, pastedBody(url), url);
      const { sourceId, result } = added;
      const view = await overview(daemon);
      const recipe = view.sources.find((source) => source.id === sourceId)?.recipe ?? null;
      const shelf = await daemon.read(TileShelf, "/api/tiles");
      const noTile = shelf.every((tile) => tile.sourceId !== sourceId);
      const recognizedOk = expectRecognized
        ? result.sync.state === "up_to_date" && !!recipe && GENERIC_RECIPES.has(recipe.id)
        : result.sync.state === "check_failed" &&
          result.sync.errorReason === "not_recognized" &&
          (result.sync.errorDetail ?? "").length > 0 &&
          recipe === null;
      await deleteSource(daemon, sourceId);
      const listed = await daemon.read(SourceList, "/api/sources");
      const deleted =
        listed.every((source) => source.id !== sourceId) &&
        !existsSync(join(sandbox.runtime, "kit", "mirrors", sourceId));
      const found = expectRecognized
        ? `${recipe ? `${recipe.id}/${recipe.unit}` : "no Recipe"} caps=${result.validation.capabilityCount}`
        : "";
      record(
        "2 paste link",
        new URL(url).pathname.slice(1),
        recognizedOk && noTile && deleted,
        Math.round(performance.now() - start),
        `${syncText(result)} ${found}${noTile ? "" : " matched a Tile"}${deleted ? "; deleted" : "; delete left it"}${added.retried ? " [retried once]" : ""}`,
      );
    } catch (error) {
      record(
        "2 paste link",
        new URL(url).pathname.slice(1),
        false,
        Math.round(performance.now() - start),
        errorText(error),
      );
    }
  }
}

// ---- step 3 and 4: Selection, Deploy, and what lands ----

type Pick = { tile: string; key: CapabilityKey };

const PICKS: readonly Pick[] = [
  { tile: "archify", key: { kind: "skill", name: "archify" } },
  { tile: "slidev", key: { kind: "skill", name: "slidev" } },
  { tile: "frontend-design", key: { kind: "skill", name: "frontend-design" } },
  { tile: "hyperframes", key: { kind: "skill", name: "hyperframes" } },
  { tile: "yestack", key: { kind: "plugin", name: "ye" } },
  { tile: "superpowers", key: { kind: "plugin", name: "superpowers" } },
  { tile: "ui-ux-pro-max", key: { kind: "plugin", name: "ui-ux-pro-max" } },
  { tile: "gstack", key: { kind: "bundle", name: "gstack" } },
];

const keyId = serializeCapabilityKey;

// The keys a pick selects: its whole Source's unit, else the key itself.
function expectedKeys(
  view: DeploymentOverview,
  picks: readonly Pick[],
  sources: Map<string, string>,
) {
  const keys = new Map<string, { key: CapabilityKey; tile: string }>();
  for (const pick of picks) {
    const sourceId = sources.get(pick.tile);
    const unit = view.rows.filter((row) => sourceId && row.wholeSourceId === sourceId);
    for (const row of unit.length > 0 ? unit : [{ key: pick.key }]) {
      keys.set(keyId(row.key), { key: row.key, tile: pick.tile });
    }
  }
  return keys;
}

async function deployPlan(daemon: Daemon, step: string): Promise<DeploymentOverview | null> {
  const start = performance.now();
  try {
    const plan = await overview(daemon);
    if (plan.activeOperation)
      throw new Error(`operation ${plan.activeOperation.operationId} already running`);
    const accepted = expectBody(
      AcceptedDeployResponse,
      await daemon.call("POST", "/api/kit/deploy", {
        selectionRevision: plan.selectionRevision,
        planToken: plan.planToken,
      }),
      202,
      "POST /api/kit/deploy",
    );
    let slowest = 0;
    let polls = 0;
    const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
    let lastNote = Date.now();
    for (;;) {
      await Bun.sleep(1000);
      const poll = await timed(() => overview(daemon));
      polls++;
      slowest = Math.max(slowest, poll.ms);
      const view = poll.value;
      const done =
        view.activeOperation === null && view.lastOperation?.operationId === accepted.operationId;
      if (done) {
        const state = view.lastOperation?.state ?? "?";
        record(
          step,
          "Deploy operation",
          state === "completed",
          Math.round(performance.now() - start),
          `plan ${plan.diff.entries.length} diff entries; operation ${state}; ${polls} Overview polls, slowest ${slowest} ms`,
        );
        return view;
      }
      if (Date.now() > deadline)
        throw new Error(`operation not finished after ${DEPLOY_TIMEOUT_MS / 60_000} min`);
      if (Date.now() - lastNote > 30_000) {
        console.error(`  ${step}: deploying, ${seconds(performance.now() - start)} elapsed`);
        lastNote = Date.now();
      }
    }
  } catch (error) {
    record(
      step,
      "Deploy operation",
      false,
      Math.round(performance.now() - start),
      errorText(error),
    );
    return null;
  }
}

type FileFact = { sha: string; exec: boolean };

function folderFacts(dir: string): Map<string, FileFact> | null {
  if (!existsSync(dir)) return null;
  const facts = new Map<string, FileFact>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = lstatSync(full);
        const bytes = entry.isSymbolicLink() ? `link:${readlinkSync(full)}` : readFileSync(full);
        facts.set(relative(dir, full), {
          sha: createHash("sha256").update(bytes).digest("hex"),
          exec: (stat.mode & 0o111) !== 0,
        });
      }
    }
  };
  walk(dir);
  return facts;
}

// A deployed skill folder holds exactly the Mirror's files, bytes, and exec bits.
function compareSkill(deployed: string, mirror: string): { ok: boolean; detail: string } {
  const want = folderFacts(mirror);
  const have = folderFacts(deployed);
  if (!want) return { ok: false, detail: `no Mirror folder ${mirror}` };
  if (!have) return { ok: false, detail: "missing" };
  const missing = [...want.keys()].filter((rel) => !have.has(rel));
  const extra = [...have.keys()].filter((rel) => !want.has(rel));
  const differ = [...want.entries()].filter(([rel, fact]) => {
    const other = have.get(rel);
    return other && (other.sha !== fact.sha || other.exec !== fact.exec);
  });
  const execs = [...have.values()].filter((fact) => fact.exec).length;
  const ok = missing.length === 0 && extra.length === 0 && differ.length === 0;
  return {
    ok,
    detail: ok
      ? `${have.size} files (${execs} exec)`
      : `${have.size}/${want.size} files; missing ${missing.slice(0, 3).join(",") || "-"} extra ${extra.slice(0, 3).join(",") || "-"} differ ${
          differ
            .slice(0, 3)
            .map(([rel]) => rel)
            .join(",") || "-"
        }`,
  };
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function claudePluginIds(sandbox: Sandbox): string[] {
  const text = readText(join(sandbox.claudeHome, "plugins", "installed_plugins.json"));
  if (!text) return [];
  const parsed = z.object({ plugins: z.record(z.unknown()) }).safeParse(JSON.parse(text));
  return parsed.success ? Object.keys(parsed.data.plugins) : [];
}

function codexPluginIds(sandbox: Sandbox): string[] {
  const text = readText(join(sandbox.codexHome, "config.toml"));
  return [...text.matchAll(/^\[plugins\."([^"]+)"\]/gm)].map((match) => match[1] ?? "");
}

// The skill names Codex puts in the model's prompt.
function codexPromptSkills(sandbox: Sandbox): { names: string[]; error: string | null } {
  const run = spawnSync("codex", ["debug", "prompt-input"], {
    cwd: sandbox.root,
    env: {
      PATH: process.env.PATH,
      HOME: sandbox.homesParent,
      CODEX_HOME: sandbox.codexHome,
      TMPDIR: sandbox.tmp,
      LANG: process.env.LANG ?? "C.UTF-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 120_000,
  });
  if (run.status !== 0)
    return {
      names: [],
      error: `codex exited ${run.status}: ${run.stderr.trim().split("\n").pop()?.trim() ?? ""}`,
    };
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (!value.includes("skills_instructions")) return;
      for (const line of value.split("\n")) {
        const match = /^- (\S+?): /.exec(line);
        if (match?.[1]) names.add(match[1]);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(JSON.parse(run.stdout));
  return { names: [...names].sort(), error: null };
}

function ledgerNames(ledger: Ledger | null): Set<string> {
  if (!ledger) return new Set();
  return new Set([
    ...ledger.skills.map((entry) => `skill:${entry.name}`),
    ...ledger.plugins.map((entry) => `plugin:${entry.name}`),
    ...ledger.bundles.map((entry) => `bundle:${entry.name}`),
  ]);
}

type Expectation = { key: CapabilityKey; tile: string };

// One row per kind. Plugins read recorded_unverified: Hive cannot hash what a
// CLI's own plugin command installed.
function verifyRows(
  view: DeploymentOverview,
  keys: readonly Expectation[],
  on: boolean,
  step: string,
) {
  for (const kind of ["skill", "plugin", "bundle"] as const) {
    const ofKind = keys.filter((entry) => entry.key.kind === kind);
    if (ofKind.length === 0) continue;
    const wanted = on
      ? kind === "skill"
        ? ["verified"]
        : kind === "plugin"
          ? ["recorded_unverified"]
          : ["verified", "recorded_unverified"]
      : ["missing"];
    const byState = new Map<string, string[]>();
    const failures: string[] = [];
    for (const { key } of ofKind) {
      const row = view.rows.find((candidate) => keyId(candidate.key) === keyId(key));
      const targets = row?.targets ?? [];
      const state =
        targets
          .map(
            (target) =>
              `${target.target}=${target.desired}/${target.reconciliation}/${target.observation}`,
          )
          .join(" ") || "no applicable target";
      byState.set(state, [...(byState.get(state) ?? []), key.name]);
      const bad = targets.filter(
        (target) =>
          target.desired !== (on ? "on" : "off") ||
          target.reconciliation !== "in_sync" ||
          !wanted.includes(target.observation),
      );
      if (!row || targets.length === 0) failures.push(`${key.name}: no row`);
      for (const target of bad) {
        const last = target.lastAttempt;
        failures.push(
          `${key.name} ${target.target}${last.state === "failed" ? ` failed ${last.code}: ${(last.detail ?? "").slice(0, 160)}` : ""}`,
        );
      }
    }
    const states = [...byState.entries()].map(([state, names]) =>
      byState.size === 1 && ofKind.length > 1 ? `all ${state}` : `${names.join(",")} ${state}`,
    );
    record(
      step,
      `Overview ${kind}s (${ofKind.length})`,
      failures.length === 0,
      0,
      `${states.join("; ")}${failures.length > 0 ? ` | ${failures.join("; ")}` : ""}`,
    );
  }
}

function verifyDisk(
  sandbox: Sandbox,
  sources: Map<string, string>,
  keys: readonly Expectation[],
  installed: boolean,
  step: string,
): void {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const skills = keys.filter((entry) => entry.key.kind === "skill");
  const skillRoots = [
    ["claude", join(sandbox.claudeHome, "skills")],
    ["agents", join(sandbox.agentsHome, "skills")],
  ] as const;
  if (installed && skills.length > 0) {
    const counts: string[] = [];
    const failures: string[] = [];
    for (const { key, tile } of skills) {
      const mirror = join(
        sandbox.runtime,
        "kit",
        "mirrors",
        sources.get(tile) ?? "?",
        "capabilities",
        "skills",
        key.name,
      );
      const compared = skillRoots.map(([target, root]) => ({
        target,
        ...compareSkill(join(root, key.name), mirror),
      }));
      for (const result of compared.filter((entry) => !entry.ok)) {
        failures.push(`${key.name} ${result.target}: ${result.detail}`);
      }
      counts.push(`${key.name} ${compared[0]?.detail ?? "?"}`);
    }
    record(
      step,
      "skill folders == Mirror",
      failures.length === 0,
      elapsed(),
      failures.length > 0
        ? failures.join("; ")
        : `same files, bytes, exec bits in claude and agents: ${counts.join(", ")}`,
    );
  }
  if (installed && keys.some((entry) => keyId(entry.key) === "skill:archify")) {
    const modes = skillRoots.map(([target, root]) => {
      const path = join(root, "archify", "bin", "archify.mjs");
      return { target, mode: existsSync(path) ? lstatSync(path).mode & 0o777 : null };
    });
    record(
      step,
      "archify bin/archify.mjs",
      modes.every((entry) => entry.mode !== null && (entry.mode & 0o111) !== 0),
      elapsed(),
      modes.map((entry) => `${entry.target} ${entry.mode?.toString(8) ?? "missing"}`).join(", "),
    );
  }
  const plugins = keys.filter((entry) => entry.key.kind === "plugin");
  if (plugins.length > 0) {
    const claudePlugins = claudePluginIds(sandbox);
    const codexPlugins = codexPluginIds(sandbox);
    let ok = true;
    const found = plugins.map(({ key }) => {
      const claude = claudePlugins.filter((id) => id.startsWith(`${key.name}@`));
      const codex = codexPlugins.filter((id) => id.startsWith(`${key.name}@`));
      // ui-ux-pro-max is a Claude-only plugin; its Codex half is the uipro bundle.
      const wantsCodex = key.name !== "ui-ux-pro-max";
      ok &&= installed
        ? claude.length === 1 && codex.length === (wantsCodex ? 1 : 0)
        : claude.length === 0 && codex.length === 0;
      return `${key.name} claude=${claude.join(",") || "-"} codex=${codex.join(",") || "-"}`;
    });
    record(step, "plugin records", ok, elapsed(), found.join("; "));
  }
  if (keys.some((entry) => keyId(entry.key) === "bundle:ui-ux-pro-max")) {
    const present = UIPRO_CODEX_SKILLS.filter((name) =>
      existsSync(join(sandbox.agentsHome, "skills", name, "SKILL.md")),
    );
    const ok = installed ? present.length === UIPRO_CODEX_SKILLS.length : present.length === 0;
    record(
      step,
      "uipro Codex skills",
      ok,
      elapsed(),
      `${present.length}/${UIPRO_CODEX_SKILLS.length} under agents skills`,
    );
  }
  if (keys.some((entry) => keyId(entry.key) === "bundle:gstack")) {
    const proofs = [
      join(sandbox.claudeHome, "skills", "gstack", "SKILL.md"),
      join(sandbox.claudeHome, "skills", "gstack-upgrade", "SKILL.md"),
      join(sandbox.codexHome, "skills", "gstack", "SKILL.md"),
      join(sandbox.codexHome, "skills", "gstack-upgrade", "SKILL.md"),
    ];
    const present = proofs.filter((path) => existsSync(path));
    const ok = installed ? present.length === proofs.length : present.length === 0;
    record(step, "gstack proofs", ok, elapsed(), `${present.length}/${proofs.length} present`);
  }
  if (!installed) {
    // Nothing else was deployed, so both skills folders must be empty.
    const leftovers = skillRoots.flatMap(([target, root]) =>
      listDir(root).map((name) => `${target}/${name}`),
    );
    record(
      step,
      "skill folders gone",
      leftovers.length === 0,
      elapsed(),
      leftovers.length > 0
        ? `left: ${leftovers.join(", ")}`
        : "claude and agents skills dirs empty",
    );
  }
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function verifyCodexPrompt(
  sandbox: Sandbox,
  keys: readonly Expectation[],
  installed: boolean,
  step: string,
): void {
  const prompt = timedSync(() => codexPromptSkills(sandbox));
  const { names, error } = prompt.value;
  if (error) {
    record(step, "codex prompt-input", false, prompt.ms, error);
    return;
  }
  const skills = keys.filter((entry) => entry.key.kind === "skill").map((entry) => entry.key.name);
  if (keys.some((entry) => keyId(entry.key) === "bundle:ui-ux-pro-max"))
    skills.push(...UIPRO_CODEX_SKILLS);
  const plugins = keys
    .filter((entry) => entry.key.kind === "plugin" && entry.key.name !== "ui-ux-pro-max")
    .map((entry) => entry.key.name);
  const listed = new Set(names);
  const skillHits = skills.filter((name) => listed.has(name));
  const pluginHits = plugins.map((plugin) => ({
    plugin,
    count: names.filter((name) => name.startsWith(`${plugin}:`)).length,
  }));
  const ok = installed
    ? skillHits.length === new Set(skills).size && pluginHits.every((hit) => hit.count > 0)
    : skillHits.length === 0 && pluginHits.every((hit) => hit.count === 0);
  const missing = [...new Set(skills)].filter((name) => !listed.has(name));
  record(
    step,
    "codex prompt-input",
    ok,
    prompt.ms,
    `${skillHits.length}/${new Set(skills).size} expected skills${installed && missing.length > 0 ? ` (missing ${missing.join(",")})` : ""}; ${pluginHits.map((hit) => `${hit.plugin}:* ${hit.count}`).join(", ")}; ${names.length} skills listed`,
  );
}

function timedSync<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: Math.round(performance.now() - start) };
}

async function verifyLedger(
  daemon: Daemon,
  keys: readonly Expectation[],
  installed: boolean,
  step: string,
): Promise<void> {
  const { value: state, ms } = await timed(() => daemon.read(KitState, "/api/kit/state"));
  const names = ledgerNames(state.ledger);
  // The agent-kit Ledger records no Tile install (ADR-0034).
  const ledgered = keys.filter((entry) => entry.key.kind !== "bundle");
  const listed = ledgered.filter((entry) => names.has(keyId(entry.key)));
  const bundles = keys.filter(
    (entry) => entry.key.kind === "bundle" && names.has(keyId(entry.key)),
  );
  const ok = installed
    ? listed.length === ledgered.length && bundles.length === 0
    : listed.length === 0 && bundles.length === 0;
  record(
    step,
    "Ledger",
    ok,
    ms,
    `${listed.length}/${ledgered.length} listed${bundles.length > 0 ? `; lists Tile bundle ${bundles.map((entry) => entry.key.name).join(",")}` : ""}${state.ledger ? `; agents=${state.ledger.agents.join(",")}` : "; no Ledger"}`,
  );
}

async function selectAndDeploy(
  daemon: Daemon,
  sandbox: Sandbox,
  sources: Map<string, string>,
  tiles: readonly string[],
): Promise<Expectation[]> {
  const picks = PICKS.filter((pick) => tiles.includes(pick.tile) && sources.has(pick.tile));
  const step = "3 select";
  const start = performance.now();
  let keys: Expectation[] = [];
  try {
    const before = await overview(daemon);
    keys = [...expectedKeys(before, picks, sources).values()];
    const current = await daemon.read(SelectionSnapshot, "/api/kit/selection");
    const committed = expectBody(
      SelectionSnapshot,
      await daemon.call("PATCH", "/api/kit/selection", {
        expectedRevision: current.revision,
        changes: picks.map((pick) => ({ key: pick.key, enabled: true, targets: BOTH })),
      }),
      200,
      "PATCH /api/kit/selection",
    );
    const enabled = new Map(
      committed.enabled.map((entry) => [keyId(entry.key), entry.targets] as const),
    );
    const missing = keys.filter(
      (entry) => !BOTH.every((target) => enabled.get(keyId(entry.key))?.includes(target)),
    );
    record(
      step,
      "PATCH selection",
      missing.length === 0,
      Math.round(performance.now() - start),
      `${picks.length} picks -> ${committed.enabled.length} enabled keys, revision ${committed.revision}${missing.length > 0 ? `; not on both: ${missing.map((entry) => keyId(entry.key)).join(",")}` : ""}`,
    );
    const hyper = sources.get("hyperframes");
    if (hyper) {
      const unit = before.rows
        .filter((row) => row.wholeSourceId === hyper)
        .map((row) => keyId(row.key));
      const on = unit.filter((id) => BOTH.every((target) => enabled.get(id)?.includes(target)));
      record(
        step,
        "hyperframes whole unit",
        unit.length === HYPERFRAMES_SKILLS && on.length === unit.length,
        0,
        `${on.length}/${unit.length} selected on both from one pick (skill:hyperframes)`,
      );
    }
    const uipro = sources.get("ui-ux-pro-max");
    if (uipro) {
      const unit = before.rows
        .filter((row) => row.wholeSourceId === uipro)
        .map((row) => keyId(row.key));
      const on = unit.filter((id) => enabled.has(id));
      record(
        step,
        "ui-ux-pro-max whole unit",
        unit.length === 2 && on.length === unit.length,
        0,
        `${on.join(", ") || "none"} selected from one pick (plugin:ui-ux-pro-max)`,
      );
    }
  } catch (error) {
    record(step, "PATCH selection", false, Math.round(performance.now() - start), errorText(error));
    return keys;
  }
  stepTimes.push({ step, ms: Math.round(performance.now() - start) });

  const deployStart = performance.now();
  const after = await deployPlan(daemon, "3 deploy");
  stepTimes.push({ step: "3 deploy", ms: Math.round(performance.now() - deployStart) });
  const verifyStart = performance.now();
  if (after) verifyRows(after, keys, true, "3 verify");
  verifyDisk(sandbox, sources, keys, true, "3 verify");
  verifyCodexPrompt(sandbox, keys, true, "3 verify");
  await verifyLedger(daemon, keys, true, "3 verify");
  stepTimes.push({ step: "3 verify", ms: Math.round(performance.now() - verifyStart) });
  return keys;
}

async function deselectAndDeploy(
  daemon: Daemon,
  sandbox: Sandbox,
  sources: Map<string, string>,
  keys: readonly Expectation[],
): Promise<void> {
  const step = "4 deselect";
  const start = performance.now();
  try {
    const current = await daemon.read(SelectionSnapshot, "/api/kit/selection");
    const committed = expectBody(
      SelectionSnapshot,
      await daemon.call("PATCH", "/api/kit/selection", {
        expectedRevision: current.revision,
        changes: current.enabled.map((entry) => ({
          key: entry.key,
          enabled: false,
          targets: entry.targets,
        })),
      }),
      200,
      "PATCH /api/kit/selection",
    );
    record(
      step,
      "PATCH selection",
      committed.enabled.length === 0,
      Math.round(performance.now() - start),
      `${current.enabled.length} enabled -> ${committed.enabled.length}; ${committed.removalIntents.length} removal intents`,
    );
  } catch (error) {
    record(step, "PATCH selection", false, Math.round(performance.now() - start), errorText(error));
    return;
  }
  stepTimes.push({ step, ms: Math.round(performance.now() - start) });
  const deployStart = performance.now();
  const after = await deployPlan(daemon, "4 deploy");
  stepTimes.push({ step: "4 deploy", ms: Math.round(performance.now() - deployStart) });
  const verifyStart = performance.now();
  if (after) verifyRows(after, keys, false, "4 verify");
  verifyDisk(sandbox, sources, keys, false, "4 verify");
  verifyCodexPrompt(sandbox, keys, false, "4 verify");
  await verifyLedger(daemon, keys, false, "4 verify");
  stepTimes.push({ step: "4 verify", ms: Math.round(performance.now() - verifyStart) });
}

// ---- main ----

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(`${args}\n${USAGE}`);
    return 2;
  }
  const realBefore = realHomeDigests();
  const sandbox = createSandbox(args.existingCodexHome);
  console.error(`sandbox ${sandbox.root}; Tiles ${args.tiles.join(", ")}`);
  let child: ChildProcess | null = null;
  try {
    const started = await timed(() => startDaemon(sandbox));
    child = started.value.child;
    const daemon = started.value.daemon;
    record("0 start", "daemon ready", true, started.ms, daemon.base);
    stepTimes.push({ step: "0 start", ms: started.ms });

    const shelfStart = performance.now();
    const sources = await addTiles(daemon, args.tiles);
    stepTimes.push({ step: "1 add Tiles", ms: Math.round(performance.now() - shelfStart) });

    const pasteStart = performance.now();
    await pasteLinks(daemon, sandbox);
    stepTimes.push({ step: "2 paste links", ms: Math.round(performance.now() - pasteStart) });

    const keys = await selectAndDeploy(daemon, sandbox, sources, args.tiles);
    if (keys.length > 0) await deselectAndDeploy(daemon, sandbox, sources, keys);
  } catch (error) {
    record("run", "error", false, 0, errorText(error));
  } finally {
    if (child) await stopDaemon(child);
    const realAfter = realHomeDigests();
    const changed = REAL_GUARDED.filter((rel) => realBefore.get(rel) !== realAfter.get(rel));
    record(
      "5 safety",
      "real homes unchanged",
      changed.length === 0,
      0,
      changed.length === 0
        ? `${REAL_GUARDED.length} paths under ${homedir()} unchanged`
        : `changed: ${changed.join(", ")}`,
    );
    if (args.keep) console.error(`kept sandbox ${sandbox.root}`);
    else rmSync(sandbox.root, { recursive: true, force: true });
    record(
      "5 safety",
      "sandbox removed",
      args.keep || !existsSync(sandbox.root),
      0,
      args.keep ? `kept ${sandbox.root}` : sandbox.root,
    );
  }
  printTable();
  return rows.every((row) => row.ok) ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
