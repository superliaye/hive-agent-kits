import { hasDaemonToDrain, shouldConfirmClose } from "./close-guard";

type DaemonDrainState = Parameters<typeof hasDaemonToDrain>[0];

export type ShellLaunchKind = "managed" | "external";

export function shouldManageDaemon(kind: ShellLaunchKind): boolean {
  return kind === "managed";
}

export function shouldConfirmShellClose(
  kind: ShellLaunchKind,
  deployInFlight: boolean,
  alreadyConfirmed: boolean,
): boolean {
  return shouldManageDaemon(kind) && shouldConfirmClose(deployInFlight, alreadyConfirmed);
}

export function shouldDrainShellDaemon(
  kind: ShellLaunchKind,
  state: DaemonDrainState,
): boolean {
  return shouldManageDaemon(kind) && hasDaemonToDrain(state);
}
