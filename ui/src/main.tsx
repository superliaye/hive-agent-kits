import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { resolveApiConfig } from "./api.ts";
import { ChromeBridge } from "./components/ChromeBridge.tsx";
import { startEventStream } from "./events.ts";
import "./styles.css";
import { createHivePersistence, readBootstrap } from "./theming-hive-persistence.ts";
import { ThemeProvider } from "./theming/index.ts";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const apiConfig = resolveApiConfig();

function Root(): JSX.Element {
  useEffect(() => startEventStream(apiConfig, queryClient), []);
  // Persistence + bootstrap are stable for the lifetime of the page;
  // memoize so a re-render of Root doesn't tear down the ThemeProvider.
  const persistence = useMemo(() => createHivePersistence(apiConfig), []);
  const bootstrap = useMemo(() => readBootstrap(), []);
  return (
    <ThemeProvider persistence={persistence} bootstrap={bootstrap}>
      <ChromeBridge />
      <QueryClientProvider client={queryClient}>
        <App apiConfig={apiConfig} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
