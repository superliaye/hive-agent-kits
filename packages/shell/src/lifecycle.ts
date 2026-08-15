import { hasDaemonToDrain, shouldConfirmClose } from "./close-guard";
import { z } from "zod";

type DaemonDrainState = Parameters<typeof hasDaemonToDrain>[0];

export type ShellLaunchKind = "managed" | "external";

const DeploymentActivityResponseSchema = z.object({
  activeOperation: z.unknown().nullable(),
});

export function deploymentActiveFromOverview(status: number, body: string): boolean {
  if (status !== 200) return true;
  try {
    const parsed = DeploymentActivityResponseSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.activeOperation !== null : true;
  } catch {
    return true;
  }
}

export function shouldManageDaemon(kind: ShellLaunchKind): boolean {
  return kind === "managed";
}

export function shouldConfirmShellClose(
  kind: ShellLaunchKind,
  deployActive: boolean,
  alreadyConfirmed: boolean,
): boolean {
  return shouldManageDaemon(kind) && shouldConfirmClose(deployActive, alreadyConfirmed);
}

export function shouldDrainShellDaemon(
  kind: ShellLaunchKind,
  state: DaemonDrainState,
): boolean {
  return shouldManageDaemon(kind) && hasDaemonToDrain(state);
}
