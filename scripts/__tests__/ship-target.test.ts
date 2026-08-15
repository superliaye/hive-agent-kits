import { describe, expect, test } from "bun:test";
import { resolveShipTarget } from "../ship-target";

describe("resolveShipTarget", () => {
  test.each([
    ["darwin", "arm64", "bun-darwin-arm64", "darwin", "arm64"],
    ["darwin", "x64", "bun-darwin-x64", "darwin", "x64"],
    ["linux", "x64", "bun-linux-x64", "linux", "x64"],
    ["win32", "x64", "bun-windows-x64", "win32", "x64"],
  ] as const)("%s/%s selects matching Bun and Electron artifacts", (platform, arch, compileTarget, electronPlatform, electronArch) => {
    expect(resolveShipTarget(platform, arch)).toEqual({
      compileTarget,
      electronPlatform,
      electronArch,
    });
  });

  test("rejects unsupported host architectures", () => {
    expect(() => resolveShipTarget("darwin", "ia32")).toThrow(
      "unsupported ship target: darwin/ia32",
    );
  });
});
