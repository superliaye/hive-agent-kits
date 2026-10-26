// Tile installer bundles (ADR-0034). A bundle pointer whose installer names a
// Tile installs with that Tile's Recipe commands, and only when the Source that
// wins the bundle is that Tile's Source. Any other pointer stays a manual install.

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeployTarget } from "@hive/contract";
import type { StagedDeployTask } from "../deploy-operations.ts";
import { readMirrorRecord } from "../mirror.ts";
import { CHECKOUT_ROOT } from "../recipes/projection.ts";
import type { InstalledPath, RepoCommand, RepoRecipe, TargetInstaller } from "../recipes/recipe.ts";
import { type Tile, tileById } from "../recipes/tiles.ts";
import { type DeployTargets, homeRedirection } from "../targets.ts";
import {
  type DeployFsExec,
  ensureDir,
  execRepoCommand,
  probeBinary,
  removeDir,
} from "./adapter.ts";
import { sha256 } from "./artifact-hash.ts";
import { boundedInstallerDetail, InstallerTaskError } from "./installer-error.ts";
import type { BundleMeta } from "./sources.ts";

const TARGET_ORDER: readonly DeployTarget[] = ["claude", "codex"];

// Records the commit a durable checkout holds, so a second target's install in
// the same Deploy reuses the first one's build.
const CHECKOUT_MARKER = ".hive-checkout";

type Homes = Pick<DeployTargets, "claudeHome" | "codexHome" | "agentsHome" | "kitTmpRoot">;

export function repoRecipeOf(tile: Tile | null): RepoRecipe | null {
  return tile?.recipe.trust === "repo" ? tile.recipe : null;
}

// The HOME a repository's commands run with.
function commandHome(targets: Pick<DeployTargets, "childEnv">): string {
  return targets.childEnv(process.env).HOME ?? homedir();
}

export function resolveInstalledPath(
  path: InstalledPath,
  targets: Homes & Pick<DeployTargets, "childEnv">,
): string {
  const base =
    path.home === "claude"
      ? targets.claudeHome()
      : path.home === "codex"
        ? targets.codexHome()
        : path.home === "agents"
          ? targets.agentsHome()
          : commandHome(targets);
  return join(base, ...path.path.split("/"));
}

function hiveCheckoutsRoot(targets: Pick<DeployTargets, "kitTmpRoot">): string {
  return join(dirname(targets.kitTmpRoot()), "checkouts");
}

// The Hive-owned folder a Tile's checkout uses when no desired target names one.
export function hiveCheckout(targets: Pick<DeployTargets, "kitTmpRoot">, tile: string): string {
  return join(hiveCheckoutsRoot(targets), tile);
}

// Where the durable checkout lives for the targets that keep the Capability.
// Every target installs from one checkout, so the location moves when the
// desired set gains or loses the target whose documentation names one.
export function checkoutLocation(
  tile: Tile,
  recipe: RepoRecipe,
  desired: readonly DeployTarget[],
  targets: Homes & Pick<DeployTargets, "childEnv">,
): string | null {
  const checkout = recipe.installer.checkout;
  if (!checkout) return null;
  for (const target of TARGET_ORDER) {
    const at = checkout.at[target];
    if (at && desired.includes(target)) return resolveInstalledPath(at, targets);
  }
  return hiveCheckout(targets, tile.id);
}

// The desired targets the Recipe installs, from the closed Selection's targets.
export function installedTargets(
  recipe: RepoRecipe,
  selected: readonly DeployTarget[],
): DeployTarget[] {
  return TARGET_ORDER.filter(
    (target) => selected.includes(target) && recipe.installer.targets[target] !== undefined,
  );
}

export type TileBundle = {
  tile: Tile;
  recipe: RepoRecipe;
  installer: TargetInstaller;
  commit: string;
  checkout: string | null;
  renderedHash: string;
};

// The commit only matters when the commands run in the checkout.
export function tileBundleHash(
  target: DeployTarget,
  tile: string,
  installer: TargetInstaller,
  checkout: string | null,
  commit: string,
): string {
  return sha256(
    JSON.stringify(["tile", target, tile, installer, checkout, checkout === null ? null : commit]),
  );
}

// Resolves only when the pointer names the Tile of the Source that wins it and
// that Tile's Recipe installs `target`. `selected` are the closed Selection's
// targets for the bundle.
export function resolveTileBundle(
  meta: BundleMeta | null,
  sourceTile: Tile | null,
  target: DeployTarget,
  selected: readonly DeployTarget[],
  targets: Homes & Pick<DeployTargets, "childEnv">,
): TileBundle | null {
  const recipe = repoRecipeOf(sourceTile);
  if (meta?.installerKind !== "tile" || !sourceTile || !recipe) return null;
  if (meta.tile !== sourceTile.id || !meta.sourceCommit) return null;
  const installer = recipe.installer.targets[target];
  if (!installer) return null;
  const desired = installedTargets(recipe, selected);
  const checkout = checkoutLocation(sourceTile, recipe, desired, targets);
  return {
    tile: sourceTile,
    recipe,
    installer,
    commit: meta.sourceCommit,
    checkout,
    renderedHash: tileBundleHash(target, sourceTile.id, installer, checkout, meta.sourceCommit),
  };
}

export function tileInstalled(
  installer: TargetInstaller,
  targets: Homes & Pick<DeployTargets, "childEnv">,
): boolean {
  return installer.proofs.every((path) => existsSync(resolveInstalledPath(path, targets)));
}

function tileRemoved(
  installer: TargetInstaller,
  targets: Homes & Pick<DeployTargets, "childEnv">,
): boolean {
  return installer.proofs.every((path) => !existsSync(resolveInstalledPath(path, targets)));
}

type TileBundleTask = Extract<StagedDeployTask, { type: "tile-bundle" }>;

type Resolved = {
  recipe: RepoRecipe;
  own: TargetInstaller;
  kept: {
    target: DeployTarget;
    checkout: string | null;
    commit: string;
    installer: TargetInstaller;
  }[];
};

function resolveTask(task: TileBundleTask): Resolved {
  const recipe = repoRecipeOf(tileById(task.tile));
  const own = recipe?.installer.targets[task.target];
  if (!recipe || !own) {
    throw new InstallerTaskError(
      "installer_failed",
      `no Tile ${task.tile} installs ${task.target}`,
    );
  }
  const kept = task.keep.map((entry) => {
    const installer = recipe.installer.targets[entry.target];
    if (!installer) {
      throw new InstallerTaskError(
        "installer_failed",
        `no Tile ${task.tile} installs ${entry.target}`,
      );
    }
    return { ...entry, installer };
  });
  return { recipe, own, kept };
}

export function tileTaskSettled(fx: DeployFsExec, task: TileBundleTask): boolean {
  const { own, kept } = resolveTask(task);
  if (task.action !== "remove") return tileInstalled(own, fx.targets);
  return (
    tileRemoved(own, fx.targets) &&
    kept.every((entry) => tileInstalled(entry.installer, fx.targets))
  );
}

function requireBinaries(fx: DeployFsExec, names: Iterable<string>): void {
  for (const name of new Set(names)) {
    if (!probeBinary(fx, name)) {
      throw new InstallerTaskError("missing_binary", `${name} is not available on PATH`);
    }
  }
}

// The Mirror's checkout/ for `sourceId`, at `commit` when one is required.
function mirrorCheckout(
  fx: DeployFsExec,
  sourceId: string | null,
  commit: string | null,
): { path: string; commit: string } | null {
  if (!sourceId) return null;
  const root = fx.targets.mirrorRoot(sourceId);
  const origin = readMirrorRecord(root)?.origin;
  const synced =
    origin?.transport === "git" || origin?.transport === "tarball" ? origin.resolvedCommit : null;
  const path = join(root, CHECKOUT_ROOT);
  if (!synced || (commit !== null && synced !== commit) || !existsSync(path)) return null;
  return { path, commit: synced };
}

function materializeCheckout(source: { path: string; commit: string }, dest: string): void {
  const marker = join(dest, CHECKOUT_MARKER);
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === source.commit) return;
  removeDir(dest);
  ensureDir(dirname(dest));
  cpSync(source.path, dest, { recursive: true });
  writeFileSync(marker, `${source.commit}\n`);
}

function runCommands(
  fx: DeployFsExec,
  tile: string,
  commands: readonly RepoCommand[],
  checkout: string | null,
): void {
  const home = commandHome(fx.targets);
  for (const command of commands) {
    const [program, ...args] = command.argv;
    if (command.cwd === "checkout" && !checkout) {
      throw new InstallerTaskError("installer_failed", `${tile} has no checkout to run ${program}`);
    }
    const cwd = command.cwd === "checkout" && checkout ? checkout : home;
    ensureDir(cwd);
    const executable = program.startsWith("./") ? join(cwd, program) : program;
    const result = execRepoCommand(
      fx,
      {
        command: executable,
        args,
        cwd,
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
      },
      program,
    );
    if (result.status !== 0) {
      throw new InstallerTaskError(
        "installer_failed",
        boundedInstallerDetail(
          [result.stdout, result.stderr].filter(Boolean).join("\n") ||
            `${program} exited ${result.status}`,
        ),
      );
    }
  }
}

function release(fx: DeployFsExec, task: TileBundleTask): void {
  if (task.release && dirname(task.release) === hiveCheckoutsRoot(fx.targets)) {
    removeDir(task.release);
  }
}

function install(fx: DeployFsExec, task: TileBundleTask, resolved: Resolved): void {
  const { recipe, own } = resolved;
  requireBinaries(fx, own.install.requires);
  if (recipe.installer.checkout) {
    const source = mirrorCheckout(fx, task.sourceId, task.commit);
    if (!source || !task.checkout) {
      throw new InstallerTaskError(
        "installer_failed",
        `${task.tile}'s Source no longer holds commit ${task.commit}; Sync and Deploy again`,
      );
    }
    materializeCheckout(source, task.checkout);
  }
  runCommands(fx, task.tile, own.install.commands, task.checkout);
  if (!tileInstalled(own, fx.targets)) {
    throw new InstallerTaskError(
      "installer_failed",
      `${task.tile} install completed without every path that proves ${task.target} installed`,
    );
  }
}

// Every check that can fail runs before the uninstaller does, so a removal
// that cannot reinstall a kept target changes nothing.
function remove(fx: DeployFsExec, task: TileBundleTask, resolved: Resolved): void {
  const { recipe, own, kept } = resolved;
  requireBinaries(fx, [
    ...own.uninstall.requires,
    ...kept.flatMap((entry) => entry.installer.install.requires),
  ]);
  const reinstallFrom = new Map<string, { path: string; commit: string }>();
  if (recipe.installer.checkout) {
    for (const entry of kept) {
      const source = mirrorCheckout(fx, task.sourceId, entry.commit);
      if (!source) {
        throw new InstallerTaskError(
          "installer_failed",
          `removing ${task.tile} from ${task.target} would also remove ${entry.target}, and its Source is unavailable to reinstall it`,
        );
      }
      reinstallFrom.set(entry.target, source);
    }
  }
  if (own.uninstall.commands.some((command) => command.cwd === "checkout")) {
    if (!task.checkout) {
      throw new InstallerTaskError("installer_failed", `${task.tile} recorded no checkout`);
    }
    if (!existsSync(task.checkout)) {
      const source = mirrorCheckout(fx, task.sourceId, null);
      if (!source) {
        throw new InstallerTaskError(
          "installer_failed",
          `${task.tile}'s checkout is gone and its Source is unavailable to restore it`,
        );
      }
      materializeCheckout(source, task.checkout);
    }
  }
  runCommands(fx, task.tile, own.uninstall.commands, task.checkout);
  for (const entry of kept) {
    const source = reinstallFrom.get(entry.target);
    if (source && entry.checkout) materializeCheckout(source, entry.checkout);
    runCommands(fx, task.tile, entry.installer.install.commands, entry.checkout);
  }
  if (!tileRemoved(own, fx.targets)) {
    throw new InstallerTaskError(
      "installer_failed",
      `${task.tile} uninstall left paths that prove ${task.target} installed`,
    );
  }
  for (const entry of kept) {
    if (!tileInstalled(entry.installer, fx.targets)) {
      throw new InstallerTaskError(
        "installer_failed",
        `${task.tile} reinstall did not restore ${entry.target}`,
      );
    }
  }
}

export function applyTileBundle(fx: DeployFsExec, task: TileBundleTask): void {
  const resolved = resolveTask(task);
  if (homeRedirection(fx.targets) === "partial") {
    throw new InstallerTaskError(
      "installer_failed",
      "only some deploy-target homes are redirected, so a repository script could write the real home",
    );
  }
  if (task.action === "remove") {
    if (!tileTaskSettled(fx, task)) remove(fx, task, resolved);
  } else {
    install(fx, task, resolved);
  }
  release(fx, task);
}
