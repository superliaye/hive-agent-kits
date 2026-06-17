// Headless screenshot for the dev-in-browser visual loop. Captures the live
// Hive UI from Vite, seeding auth from ~/.hive/.token the same way the UI's
// resolveApiConfig() consumes it (?baseUrl= + ?token= in browser-tab mode,
// packages/ui/src/api.ts), so there's no interactive login. The dev stack must
// be running (scripts/dev.ps1) — this only captures, it doesn't launch.
//
//   bun run scripts/screenshot.ts [route] --out <path> [--full-page]
//     [--wait <selector>] [--viewport WxH] [--vite <url>] [--daemon <url>]
//
// Defaults match scripts/dev.ts: route /, vite http://localhost:5173,
// daemon http://127.0.0.1:3117.
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
import { chromium } from "@playwright/test";

declare const Bun: unknown;
const onBun = typeof Bun !== "undefined";

const DEFAULT_VITE = "http://localhost:5173";
const DEFAULT_DAEMON = "http://127.0.0.1:3117";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MIN_PNG_BYTES = 1024;

type Args = {
  route: string;
  out: string;
  fullPage: boolean;
  wait?: string;
  viewport: { width: number; height: number };
  vite: string;
  daemon: string;
};

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`bad --viewport "${value}" — expected WxH, e.g. 1280x800`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
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
  let routeSeen = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        out = nextValue(argv, i, "--out");
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
  return { route, out, fullPage, wait, viewport, vite, daemon };
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
function buildUrl(args: Args, token: string): { url: string; redacted: string } {
  const target = new URL(args.route, args.vite);
  target.searchParams.set("baseUrl", args.daemon);
  target.searchParams.set("token", token);
  const redacted = new URL(target.toString());
  redacted.searchParams.set("token", "***");
  return { url: target.toString(), redacted: redacted.toString() };
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

async function main(): Promise<void> {
  if (onBun) {
    process.exit(reExecUnderNode());
  }
  const args = parseArgs(process.argv.slice(2));
  const token = readToken();
  const { url, redacted } = buildUrl(args, token);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: args.viewport });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
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
  } finally {
    await browser.close();
  }

  const { size } = statSync(args.out);
  if (size < MIN_PNG_BYTES) {
    throw new Error(`screenshot ${args.out} is only ${size} bytes — likely a blank/failed render`);
  }
  console.log(`captured ${redacted}`);
  console.log(`  → ${args.out} (${size} bytes)`);
}

main().catch((err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`screenshot failed: ${reason}`);
  process.exit(1);
});
