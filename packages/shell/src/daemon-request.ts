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

export type DaemonFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DaemonConnectionStatus = "connected" | "disconnected";

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
): (path: string, request: SerializedDaemonRequest) => Promise<SerializedDaemonResponse> {
  return async (path, request) => {
    const parsedPath = validateRelativeApiPath(path);
    const headers = new Headers(request.headers);
    if (headers.has("authorization")) {
      throw new Error("renderer must not provide an authorization header");
    }
    headers.set("authorization", `Bearer ${connection.token}`);
    let response: Response;
    let body: string;
    try {
      response = await daemonFetch(
        `${connection.baseUrl}${parsedPath.pathname}${parsedPath.search}`,
        {
          method: request.method,
          headers,
          body: request.body,
        },
      );
      body = await response.text();
      onStatus?.("connected");
    } catch (error) {
      onStatus?.("disconnected");
      throw error;
    }
    return {
      status: response.status,
      statusText: response.statusText,
      body,
    };
  };
}
