import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { parseTar, topFolder } from "../tar.ts";
import { buildGzipTar, buildTar, type TarFixtureEntry } from "./helpers.ts";

describe("parseTar", () => {
  test("extracts files and dirs from a hand-built ustar buffer", () => {
    const entries: TarFixtureEntry[] = [
      { path: "top/" },
      { path: "top/capabilities/" },
      { path: "top/capabilities/skills/foo/SKILL.md", content: "hello skill" },
      { path: "top/presets/engineering.yaml", content: "name: engineering\n" },
    ];
    const parsed = parseTar(buildTar(entries));

    const files = parsed.filter((e) => e.type === "file");
    const dirs = parsed.filter((e) => e.type === "dir");

    expect(files.map((f) => f.path).sort()).toEqual([
      "top/capabilities/skills/foo/SKILL.md",
      "top/presets/engineering.yaml",
    ]);
    expect(dirs.length).toBeGreaterThanOrEqual(2);

    const skill = files.find((f) => f.path.endsWith("SKILL.md"));
    expect(skill).toBeDefined();
    expect(new TextDecoder().decode(skill?.data)).toBe("hello skill");
  });

  test("round-trips through gzip (the codeload wire format)", () => {
    const gz = buildGzipTar([{ path: "top/" }, { path: "top/file.txt", content: "gzipped" }]);
    const raw = new Uint8Array(gunzipSync(Buffer.from(gz)));
    const parsed = parseTar(raw);
    const f = parsed.find((e) => e.path === "top/file.txt");
    expect(f).toBeDefined();
    expect(new TextDecoder().decode(f?.data)).toBe("gzipped");
  });

  test("bounds every archive header, including directories, before returning entries", () => {
    const tar = buildTar([{ path: "one/" }, { path: "two/" }, { path: "three/" }]);
    expect(() => parseTar(tar, undefined, 2)).toThrow("tar archive exceeds entry limit");
  });

  test("counts metadata headers against the archive entry limit", () => {
    const header = (type: string) => {
      const block = new Uint8Array(512);
      block.set(new TextEncoder().encode("metadata"), 0);
      block.set(new TextEncoder().encode("0000000\0"), 100);
      block.set(new TextEncoder().encode("00000000000\0"), 124);
      block[156] = type.charCodeAt(0);
      return block;
    };
    const tar = new Uint8Array(512 * 5);
    tar.set(header("g"), 0);
    tar.set(header("x"), 512);
    tar.set(header("L"), 1024);
    expect(() => parseTar(tar, undefined, 2)).toThrow("tar archive exceeds entry limit");
  });
});

describe("topFolder (content-derived strip)", () => {
  test("returns the common first path component", () => {
    const parsed = parseTar(
      buildTar([
        { path: "my-agent-kits-abc/" },
        { path: "my-agent-kits-abc/capabilities/skills/x/SKILL.md", content: "x" },
        { path: "my-agent-kits-abc/presets/p.yaml", content: "p" },
      ]),
    );
    expect(topFolder(parsed)).toBe("my-agent-kits-abc");
  });

  // CRUCIAL: a RENAMED top folder still strips — the strip is content-derived,
  // never hard-coded to my-agent-kits-<sha>.
  test("a renamed top folder still yields a content-derived strip", () => {
    const parsed = parseTar(
      buildTar([
        { path: "renamed-top/" },
        { path: "renamed-top/capabilities/skills/x/SKILL.md", content: "x" },
        { path: "renamed-top/capabilities/skills/y/SKILL.md", content: "y" },
      ]),
    );
    const strip = topFolder(parsed);
    expect(strip).toBe("renamed-top");
    expect(strip).not.toContain("my-agent-kits");

    // The strip applied yields paths under the content root, not the folder name.
    const stripped = parsed
      .filter((e) => e.type === "file")
      .map((e) => e.path.slice(`${strip}/`.length));
    expect(stripped.sort()).toEqual([
      "capabilities/skills/x/SKILL.md",
      "capabilities/skills/y/SKILL.md",
    ]);
  });

  test("returns empty string when entries do not share a first segment", () => {
    const parsed = parseTar(
      buildTar([
        { path: "a/file.txt", content: "1" },
        { path: "b/file.txt", content: "2" },
      ]),
    );
    expect(topFolder(parsed)).toBe("");
  });

  test("returns empty string for no entries", () => {
    expect(topFolder([])).toBe("");
  });
});
