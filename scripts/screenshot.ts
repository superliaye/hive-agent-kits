// Headless screenshot for the dev visual loop. Two capture targets:
//
//   - Default (browser mode): launches headless Chromium against the Vite URL,
//     seeding auth from ~/.hive/.token exactly as the UI's resolveApiConfig()
//     consumes it (?baseUrl= + ?token=, packages/ui/src/api.ts) — no login.
//     This is the WEB rendering: light theme, no window.__hive (Electron-only
//     features render their "unavailable" state). Fast layout/light-theme check.
//
//   - --cdp <port>: attaches to the REAL Electron desktop window over Chrome
//     DevTools Protocol (the dev shell opens this port — main.ts, HIVE_CDP_PORT,
//     default 9333). This captures the actual app: dark chrome, window.__hive
//     present, native features live. Use this to verify desktop-only surface.
//     No token seeding — the renderer is already authed by the shell.
//
// Either way the dev stack must already be running (scripts/dev.ps1); this only
// captures, it never launches.
//
//   bun run scripts/screenshot.ts [route] --out <path> [--full-page]
//     [--wait <selector>] [--viewport WxH] [--vite <url>] [--daemon <url>]
//   bun run scripts/screenshot.ts --cdp 9333 --out window.png   # real window
//
// Defaults match scripts/dev.ts: route /, vite http://localhost:5173,
// daemon http://127.0.0.1:3117. For a parallel -Instance N stack, point --cdp
// at 9333+N (and --vite/--daemon at 5173+N / 3117+N in browser mode).
//
// This is a root scripts/ I/O edge, not daemon source: plain async + process
// exit codes, no Effect-TS. The token value is never logged.
//
// Runs under `bun run`, but Playwright cannot drive a browser from a Bun parent
// (Bun doesn't wire the extra stdio fds Playwright needs for the chrome control
// pipe, so the launch hangs). So under Bun we re-exec this same file under Node
// (which runs the .ts directly via type-stripping) and do the capture there.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import { PNG } from "pngjs";

declare const Bun: unknown;
const onBun = typeof Bun !== "undefined";

const DEFAULT_VITE = "http://localhost:5173";
const DEFAULT_DAEMON = "http://127.0.0.1:3117";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MIN_PNG_BYTES = 1024;

// Non-blank content metric. A solid-black (or solid-chrome) PNG can exceed
// MIN_PNG_BYTES, so the byte guard does not prove a render. We decode the PNG,
// find the MODAL pixel color (the dominant background), and measure the fraction
// of pixels whose per-channel value differs from that modal color by >= DELTA.
// A uniform frame (all black, or all chrome) leaves ~0% differing → blank; a real
// UI's text/controls push that fraction past MIN_CONTENT_FRACTION → has content.
// This distinguishes "has UI" from "uniform fill" where a raw stdev check cannot,
// because the chrome is itself near-black.
//
// Assumption: the captured route is content-dense (the app's real surfaces clear
// 2% comfortably — verified on the Electron window and the Settings page). A
// deliberately sparse route (a near-empty page, a single heading on a flat
// background) could fall under 2% and false-FAIL; point this at a content-bearing
// route, or raise the route's density, rather than loosening the blank guard.
const CONTENT_DELTA = 16; // per-channel difference (0..255) that counts as "differs"
const MIN_CONTENT_FRACTION = 0.02; // >= 2% of pixels must differ from the modal color

export type ContentCheck = { ok: boolean; modal: string; differingFraction: number };

// Pure, unit-testable on a synthetic buffer. Decodes a PNG buffer and reports
// whether enough pixels differ from the modal color to be a real render.
export function assessNonBlank(pngBuffer: Buffer): ContentCheck {
  const png = PNG.sync.read(pngBuffer);
  const { data, width, height } = png;
  const pixelCount = width * height;
  if (pixelCount === 0) {
    return { ok: false, modal: "#000000", differingFraction: 0 };
  }

  // Tally pixel colors (RGB, alpha ignored) to find the modal color.
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let modalKey = 0;
  let modalCount = -1;
  for (const [key, count] of counts) {
    if (count > modalCount) {
      modalCount = count;
      modalKey = key;
    }
  }
  const mr = (modalKey >> 16) & 0xff;
  const mg = (modalKey >> 8) & 0xff;
  const mb = modalKey & 0xff;

  let differing = 0;
  for (let i = 0; i < data.length; i += 4) {
    const dr = Math.abs((data[i] ?? 0) - mr);
    const dg = Math.abs((data[i + 1] ?? 0) - mg);
    const db = Math.abs((data[i + 2] ?? 0) - mb);
    if (dr >= CONTENT_DELTA || dg >= CONTENT_DELTA || db >= CONTENT_DELTA) {
      differing++;
    }
  }
  const differingFraction = differing / pixelCount;
  const modal = `#${modalKey.toString(16).padStart(6, "0")}`;
  return { ok: differingFraction >= MIN_CONTENT_FRACTION, modal, differingFraction };
}

// Throws a loud "blank render" error if the captured PNG is uniform. Run for both
// browser and --cdp captures, after the cheap MIN_PNG_BYTES pre-check.
export function assertNonBlank(pngBuffer: Buffer, out: string): void {
  const { ok, modal, differingFraction } = assessNonBlank(pngBuffer);
  if (!ok) {
    throw new Error(
      `blank render — ${out} is a uniform frame (modal ${modal}, only ` +
        `${(differingFraction * 100).toFixed(2)}% of pixels differ; need >= ` +
        `${(MIN_CONTENT_FRACTION * 100).toFixed(0)}%). The window likely captured an ` +
        `empty compositor surface.`,
    );
  }
}

type Args = {
  route: string;
  out: string;
  fullPage: boolean;
  wait?: string;
  viewport: { width: number; height: number };
  vite: string;
  daemon: string;
  // When set, attach to the running Electron window on this CDP port instead of
  // launching a browser against Vite.
  cdp?: number;
};

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`bad --viewport "${value}" — expected WxH, e.g. 1280x800`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new Error(`bad --viewport "${value}" — width and height must be positive`);
  }
  return { width, height };
}

function nextValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  let route = "/";
  let out = "";
  let fullPage = false;
  let wait: string | undefined;
  let viewport = DEFAULT_VIEWPORT;
  let vite = DEFAULT_VITE;
  let daemon = DEFAULT_DAEMON;
  let cdp: number | undefined;
  let routeSeen = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        out = nextValue(argv, i, "--out");
        i++;
        break;
      case "--cdp":
        cdp = parseCdpPort(nextValue(argv, i, "--cdp"));
        i++;
        break;
      case "--full-page":
        fullPage = true;
        break;
      case "--wait":
        wait = nextValue(argv, i, "--wait");
        i++;
        break;
      case "--viewport":
        viewport = parseViewport(nextValue(argv, i, "--viewport"));
        i++;
        break;
      case "--vite":
        vite = nextValue(argv, i, "--vite");
        i++;
        break;
      case "--daemon":
        daemon = nextValue(argv, i, "--daemon");
        i++;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown flag ${arg}`);
        }
        if (routeSeen) {
          throw new Error(`unexpected positional argument "${arg}"`);
        }
        route = arg;
        routeSeen = true;
    }
  }

  if (out === "") {
    throw new Error("--out <path> is required");
  }
  return { route, out, fullPage, wait, viewport, vite, daemon, cdp };
}

function parseCdpPort(value: string): number {
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`bad --cdp "${value}" — expected a port number, e.g. 9333`);
  }
  return port;
}

function readToken(): string {
  const fromEnv = process.env.HIVE_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const tokenPath = join(homedir(), ".hive", ".token");
  let raw: string;
  try {
    raw = readFileSync(tokenPath, "utf8");
  } catch {
    throw new Error(`no ${tokenPath} — start the dev stack first (dev.ps1)`);
  }
  const token = raw.trim();
  if (token === "") {
    throw new Error(`empty token at ${tokenPath} — start the dev stack first (dev.ps1)`);
  }
  return token;
}

// route + daemon + token folded into the dev-in-browser URL resolveApiConfig()
// reads. Token kept separate from the returned `redacted` form for logging.
// `route` must be a same-origin path: an absolute or protocol-relative route
// would discard the Vite base via `new URL(route, vite)` and ship the token to
// an arbitrary origin, so reject anything that resolves off the Vite origin.
function buildUrl(args: Args, token: string): { url: string; redacted: string } {
  const viteOrigin = new URL(args.vite).origin;
  const target = new URL(args.route, args.vite);
  if (target.origin !== viteOrigin) {
    throw new Error(`route "${args.route}" must be a path on ${viteOrigin}, not an absolute URL`);
  }
  target.searchParams.set("baseUrl", args.daemon);
  target.searchParams.set("token", token);
  const redacted = new URL(target.toString());
  redacted.searchParams.set("token", "***");
  return { url: target.toString(), redacted: redacted.toString() };
}

// Defense-in-depth for the "token is never logged" guarantee: Playwright's
// navigation errors embed the full target URL (token and all), so scrub every
// occurrence of the raw token from any string before it reaches a log.
function redact(text: string, token: string): string {
  return text.split(token).join("***");
}

// Re-run this file under Node, forwarding the original args. Node strips the
// TS types and resolves @playwright/test from the same root node_modules.
function reExecUnderNode(): number {
  const self = fileURLToPath(import.meta.url);
  const result = spawnSync("node", [self, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`failed to re-exec under node: ${result.error.message}`);
  }
  return result.status ?? 1;
}

// Browser mode: launch headless Chromium against the Vite URL with seeded auth.
// Returns the redacted target for logging.
async function captureViaBrowser(args: Args): Promise<string> {
  const token = readToken();
  const { url, redacted } = buildUrl(args, token);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: args.viewport });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (err) {
      const reason = redact(err instanceof Error ? err.message : String(err), token);
      throw new Error(
        `navigation to ${redacted} failed — is the dev stack up? (dev.ps1): ${reason}`,
      );
    }
    if (args.wait) {
      await page.waitForSelector(args.wait);
    }
    // App-mounted readiness: React renders into <div id="root"> (ui/index.html).
    await page.waitForSelector("#root > *");
    await page.screenshot({ path: args.out, fullPage: args.fullPage });
  } catch (err) {
    // Any later Playwright error can also embed the token-bearing URL; scrub it
    // here while the token is still in scope, before it reaches the logger.
    throw err instanceof Error ? new Error(redact(err.message, token)) : err;
  } finally {
    await browser.close();
  }
  return redacted;
}

// CDP mode: attach to the already-running Electron window and screenshot it.
// No token handling — the shell authed the renderer at launch. Returns the
// endpoint for logging. --viewport is ignored here; the real window is captured
// at its own size.
async function captureViaCdp(args: Args, cdp: number): Promise<string> {
  const endpoint = `http://127.0.0.1:${cdp}`;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not attach to Electron on ${endpoint} — is this instance's dev shell up? (dev.ps1): ${reason}`,
    );
  }
  try {
    const page = pickRendererPage(browser);
    if (args.wait) {
      await page.waitForSelector(args.wait);
    }
    await page.waitForSelector("#root > *");
    await page.screenshot({ path: args.out, fullPage: args.fullPage });
  } finally {
    // connectOverCDP: close() detaches Playwright from the window; it does NOT
    // quit Electron, so the live dev window survives the capture.
    await browser.close();
  }
  return endpoint;
}

// The Electron renderer window is an http(s) page; devtools targets use the
// devtools:// scheme. Pick the first real renderer page.
function pickRendererPage(browser: Browser): Page {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (/^https?:/.test(page.url())) {
        return page;
      }
    }
  }
  throw new Error(
    "no renderer window found over CDP — the Electron dev window may not be open yet",
  );
}

async function main(): Promise<void> {
  if (onBun) {
    process.exit(reExecUnderNode());
  }
  const args = parseArgs(process.argv.slice(2));
  const target =
    args.cdp !== undefined ? await captureViaCdp(args, args.cdp) : await captureViaBrowser(args);

  const { size } = statSync(args.out);
  if (size < MIN_PNG_BYTES) {
    throw new Error(`screenshot ${args.out} is only ${size} bytes — likely a blank/failed render`);
  }
  // Cheap byte guard passed; now prove the frame actually rendered content (a
  // solid-black PNG can exceed MIN_PNG_BYTES). Runs for both browser and --cdp modes.
  assertNonBlank(readFileSync(args.out), args.out);
  console.log(`captured ${target}`);
  console.log(`  → ${args.out} (${size} bytes)`);
}

// Only run when invoked directly (`bun run scripts/screenshot.ts …` or the
// Node re-exec), not when imported by a unit test of the pure assertions above.
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`screenshot failed: ${reason}`);
    process.exit(1);
  });
}
