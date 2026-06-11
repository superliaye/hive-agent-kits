import { describe, expect, test } from "bun:test";
import type { FsRunnerPort } from "../../effect/ports.ts";
import { makeEditTool, makeReadTool, makeWriteTool } from "../file-tools.ts";
import type { ToolContext } from "../registry.ts";

const CWD = process.platform === "win32" ? "C:\\hive\\ws" : "/hive/ws";

function ctx(): ToolContext {
  return {
    agentId: "a",
    runId: "r",
    cwd: CWD,
    boundSkills: [],
    signal: new AbortController().signal,
  };
}

// In-memory FsRunner — keyed by absolute path. Mirrors the real port's verbs.
function memFs(seed: Record<string, string> = {}): {
  fs: FsRunnerPort;
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const fs: FsRunnerPort = {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    fileExists: async (p) => files.has(p),
  };
  return { fs, files };
}

describe("file tools — write / read round-trip", () => {
  test("write then read returns the content", async () => {
    const { fs, files } = memFs();
    const write = makeWriteTool(fs);
    const read = makeReadTool(fs);

    const w = await write.run({ path: "notes/a.txt", content: "hello" }, ctx());
    expect(w.isError).toBe(false);
    // Wrote under the workspace, not at the model-provided relative path.
    expect([...files.keys()].some((k) => k.endsWith("a.txt"))).toBe(true);

    const r = await read.run({ path: "notes/a.txt" }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toBe("hello");
  });

  test("read of a missing file → isError", async () => {
    const { fs } = memFs();
    const r = await makeReadTool(fs).run({ path: "nope.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
  });
});

describe("file tools — edit contract", () => {
  test("edit replaces a unique old_str", async () => {
    const abs = process.platform === "win32" ? `${CWD}\\f.txt` : `${CWD}/f.txt`;
    const { fs, files } = memFs({ [abs]: "alpha BETA gamma" });
    const r = await makeEditTool(fs).run(
      { path: "f.txt", old_str: "BETA", new_str: "delta" },
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(files.get(abs)).toBe("alpha delta gamma");
  });

  test("edit with a missing old_str → isError, file unchanged", async () => {
    const abs = process.platform === "win32" ? `${CWD}\\f.txt` : `${CWD}/f.txt`;
    const { fs, files } = memFs({ [abs]: "alpha BETA gamma" });
    const r = await makeEditTool(fs).run({ path: "f.txt", old_str: "ZETA", new_str: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
    expect(files.get(abs)).toBe("alpha BETA gamma");
  });

  test("edit with a non-unique old_str → isError, file unchanged", async () => {
    const abs = process.platform === "win32" ? `${CWD}\\f.txt` : `${CWD}/f.txt`;
    const { fs, files } = memFs({ [abs]: "x x" });
    const r = await makeEditTool(fs).run({ path: "f.txt", old_str: "x", new_str: "y" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not unique");
    expect(files.get(abs)).toBe("x x");
  });
});

describe("file tools — workspace confinement", () => {
  test("rejects a `..` escape on read/write/edit", async () => {
    const { fs } = memFs();
    for (const [name, tool, input] of [
      ["read", makeReadTool(fs), { path: "../secret" }],
      ["write", makeWriteTool(fs), { path: "../secret", content: "x" }],
      ["edit", makeEditTool(fs), { path: "../secret", old_str: "a", new_str: "b" }],
    ] as const) {
      const r = await tool.run(input, ctx());
      expect(r.isError, name).toBe(true);
      expect(r.content, name).toContain("escapes the workspace");
    }
  });

  test("rejects an absolute path", async () => {
    const { fs } = memFs();
    const abs = process.platform === "win32" ? "C:\\Windows\\system32" : "/etc/passwd";
    const r = await makeReadTool(fs).run({ path: abs }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace");
  });

  test("malformed input → isError, fs never touched", async () => {
    let touched = false;
    const fs: FsRunnerPort = {
      readFile: async () => {
        touched = true;
        return "";
      },
      writeFile: async () => {
        touched = true;
      },
      fileExists: async () => {
        touched = true;
        return true;
      },
    };
    const r = await makeWriteTool(fs).run({ path: 123 }, ctx());
    expect(r.isError).toBe(true);
    expect(touched).toBe(false);
  });
});
