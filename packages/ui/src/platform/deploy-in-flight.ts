// Renderer→main bridge for the deploy-in-flight signal (Feature 3).
//
// The Kit deploy page calls this when its deploy mutation starts (true) and when
// it settles (false). In Electron it reaches the main process's
// `hive:setDeployInFlight` IPC handler (via the preload bridge); in a plain
// browser tab (Vite dev) window.__hive is undefined and this is a silent no-op —
// a beforeunload guard in the renderer would not protect the daemon anyway, since
// the SIGKILL is a main-process action.
export async function signalDeployInFlight(inFlight: boolean): Promise<void> {
  const bridge = typeof window !== "undefined" ? window.__hive?.setDeployInFlight : undefined;
  if (!bridge) return;
  await bridge(inFlight);
}
