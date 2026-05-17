import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { resolveApiConfig } from "./api.ts";
import App from "./App.tsx";
import { startEventStream } from "./events.ts";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const apiConfig = resolveApiConfig();

function Root(): JSX.Element {
  useEffect(() => startEventStream(apiConfig, queryClient), []);
  return (
    <QueryClientProvider client={queryClient}>
      <App apiConfig={apiConfig} />
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
