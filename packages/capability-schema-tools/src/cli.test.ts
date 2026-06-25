import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "captools-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The CLI roots at <repo-root>/capabilities (capabilitiesRoot), so fixtures live
// under capabilities/skills/<rel> and the bin is pointed at the repo root.
function writeSkill(rel: string, fm: string): void {
  const dir = join(root, "capabilities", "skills", rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\nbody\n`);
}

async function runCli(...args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("capability-validate CLI", () => {
  test("exits 0 on a conformant repo", async () => {
    writeSkill("ok-skill", "name: ok-skill\ndescription: fine");
    const { code } = await runCli(root);
    expect(code).toBe(0);
  });

  test("exits 1 on a repo with conformance errors", async () => {
    writeSkill("Bad", "name: Bad\ndescription: nope");
    const { code } = await runCli(root);
    expect(code).toBe(1);
  });

  test("--json emits a parseable ValidationResult", async () => {
    writeSkill("Bad", "name: Bad\ndescription: nope");
    const { code, stdout } = await runCli(root, "--json");
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.conformant).toBe(false);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test("pointed at a repo ROOT with capabilities/skills/Bad, finds the error (no false-conformant)", async () => {
    // The repo root has the capabilities/ subtree; the CLI must descend into it
    // rather than report conformant because the root itself has no skills/.
    writeSkill("Bad", "name: Bad\ndescription: nope");
    const { code } = await runCli(root);
    expect(code).toBe(1);
  });
});
