import type { CapabilityKey } from "@hive/capability-schema";
import type { DeploymentOverview, DeployTarget, SelectionSnapshot } from "@hive/contract";
import type { ServerHandles } from "../index.ts";

export type DesiredEntry = { key: CapabilityKey; targets: DeployTarget[] };

function request(token: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
}

function entryId(entry: { key: CapabilityKey }): string {
  return `${entry.key.kind}:${entry.key.name}`;
}

export async function acceptDesiredSelection(
  server: ServerHandles,
  token: string,
  desired: readonly DesiredEntry[],
): Promise<DeploymentOverview> {
  const current = (await (
    await server.app.fetch(request(token, "/api/kit/selection"))
  ).json()) as SelectionSnapshot;
  const desiredByKey = new Map(desired.map((entry) => [entryId(entry), entry]));
  const currentByKey = new Map(current.enabled.map((entry) => [entryId(entry), entry]));
  const changes: Array<{ key: CapabilityKey; enabled: boolean; targets: DeployTarget[] }> = [];
  for (const entry of current.enabled) {
    const wanted = desiredByKey.get(entryId(entry));
    const targets = entry.targets.filter((target) => !wanted?.targets.includes(target));
    if (targets.length > 0) changes.push({ key: entry.key, enabled: false, targets });
  }
  for (const entry of desired) {
    const prior = currentByKey.get(entryId(entry));
    const targets = entry.targets.filter((target) => !prior?.targets.includes(target));
    if (targets.length > 0) changes.push({ key: entry.key, enabled: true, targets });
  }
  if (changes.length > 0) {
    const response = await server.app.fetch(
      request(token, "/api/kit/selection", {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: current.revision, changes }),
      }),
    );
    if (response.status !== 200) throw new Error(`selection mutation failed: ${response.status}`);
  }

  let operationId = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const overview = (await (
      await server.app.fetch(request(token, "/api/kit/overview"))
    ).json()) as DeploymentOverview;
    const accepted = await server.app.fetch(
      request(token, "/api/kit/deploy", {
        method: "POST",
        body: JSON.stringify({
          selectionRevision: overview.selectionRevision,
          planToken: overview.planToken,
        }),
      }),
    );
    const body = (await accepted.json()) as { error?: string; operationId?: string };
    if (accepted.status === 409 && body.error === "plan_stale") continue;
    if (accepted.status !== 202 || !body.operationId) {
      throw new Error(`deploy acceptance failed: ${accepted.status}`);
    }
    operationId = body.operationId;
    break;
  }
  if (!operationId) throw new Error("deploy acceptance did not stabilize");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const overview = (await (
      await server.app.fetch(request(token, "/api/kit/overview"))
    ).json()) as DeploymentOverview;
    if (overview.lastOperation?.operationId === operationId && !overview.activeOperation) {
      return overview;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation ${operationId} did not finish`);
}
