export type ShipTarget = {
  compileTarget: string;
  electronPlatform: "darwin" | "linux" | "win32";
  electronArch: "arm64" | "x64";
};

export function resolveShipTarget(platform: string, arch: string): ShipTarget {
  if (arch !== "x64" && !(platform === "darwin" && arch === "arm64")) {
    throw new Error(`unsupported ship target: ${platform}/${arch}`);
  }

  if (platform === "darwin") {
    return {
      compileTarget: `bun-darwin-${arch}`,
      electronPlatform: "darwin",
      electronArch: arch,
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      compileTarget: "bun-linux-x64",
      electronPlatform: "linux",
      electronArch: "x64",
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      compileTarget: "bun-windows-x64",
      electronPlatform: "win32",
      electronArch: "x64",
    };
  }
  throw new Error(`unsupported ship target: ${platform}/${arch}`);
}
