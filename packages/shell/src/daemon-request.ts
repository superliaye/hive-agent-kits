export type ActiveDaemonConnection = {
  kind: "managed" | "external";
  baseUrl: string;
  token: string;
  displayName: string;
};

export type SerializedDaemonRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type SerializedDaemonResponse = {
  status: number;
  statusText: string;
  body: string;
};

export type DaemonFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type DaemonConnectionStatus = "connected" | "disconnected" | "reauthentication_required";

export const DAEMON_REQUEST_TIMEOUT_MS = 30_000;
export const BACKEND_UPGRADE_REQUEST_TIMEOUT_MS = 150_000;

export function daemonRequestTimeoutMs(path: string, method = "GET"): number | null {
  // These mutations commit or acquire on the Daemon before replying. Their valid
  // duration is data-dependent, so a Shell-side deadline can report failure after
  // work has succeeded. The Daemon owns their operation bounds.
  if (method === "POST" && (path === "/api/kit/sync" || path === "/api/sources")) return null;
  if (method === "POST" && /^\/api\/backends\/[^/]+\/upgrade$/.test(path)) {
    return BACKEND_UPGRADE_REQUEST_TIMEOUT_MS;
  }
  return DAEMON_REQUEST_TIMEOUT_MS;
}

function validateRelativeApiPath(path: string): URL {
  if (!path.startsWith("/api/") || path.includes("\\")) {
    throw new Error("daemon path must be a relative /api/* path");
  }
  const parsed = new URL(path, "http://hive.invalid");
  if (parsed.origin !== "http://hive.invalid" || !parsed.pathname.startsWith("/api/")) {
    throw new Error("daemon path must be a relative /api/* path");
  }
  if (parsed.hash !== "") throw new Error("daemon path must be a relative /api/* path");
  return parsed;
}

export function createDaemonRequestHandler(
  connection: ActiveDaemonConnection,
  daemonFetch: DaemonFetch = fetch,
  onStatus?: (status: DaemonConnectionStatus) => void,
  timeoutMs?: number,
): (path: string, request: SerializedDaemonRequest) => Promise<SerializedDaemonResponse> {
  let statusEpoch = 0;
  let reauthenticationRequired = false;
  return async (path, request) => {
    const requestEpoch = ++statusEpoch;
    const parsedPath = validateRelativeApiPath(path);
    const headers = new Headers(request.headers);
    if (headers.has("authorization")) {
      throw new Error("renderer must not provide an authorization header");
    }
    headers.set("authorization", `Bearer ${connection.token}`);
    let response: Response;
    let body: string;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const requestTimeoutMs =
      timeoutMs ?? daemonRequestTimeoutMs(parsedPath.pathname, request.method ?? "GET");
    const deadline =
      requestTimeoutMs === null
        ? null
        : new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error("daemon request timed out"));
            }, requestTimeoutMs);
          });
    const withinDeadline = <T>(operation: Promise<T>): Promise<T> =>
      deadline ? Promise.race([operation, deadline]) : operation;
    const publish = (status: DaemonConnectionStatus): void => {
      if (requestEpoch !== statusEpoch || reauthenticationRequired) return;
      if (status === "reauthentication_required") reauthenticationRequired = true;
      onStatus?.(status);
    };
    try {
      response = await withinDeadline(
        daemonFetch(`${connection.baseUrl}${parsedPath.pathname}${parsedPath.search}`, {
          method: request.method,
          headers,
          body: request.body,
          signal: controller.signal,
        }),
      );
      body = await withinDeadline(response.text());
      if (response.status === 401) {
        publish(connection.kind === "external" ? "reauthentication_required" : "disconnected");
      } else {
        publish("connected");
      }
    } catch (error) {
      if (!timedOut) publish("disconnected");
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return {
      status: response.status,
      statusText: response.statusText,
      body,
    };
  };
}
