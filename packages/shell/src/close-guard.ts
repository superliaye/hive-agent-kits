// Close-during-deploy guard predicate (Feature 3).
//
// On quit the shell SIGKILLs the daemon to drain it (main.ts before-quit),
// truncating an in-flight deploy mid-write. This pure predicate decides whether
// before-quit must first show a confirm dialog. Factored out so the decision is
// unit-tested even though the dialog itself is manual.
//
//   inFlight         — the Daemon reports a durable deploy operation as active.
//   alreadyConfirmed — the user already chose "Close anyway" this quit cycle, so
//                      we must NOT prompt again (the second before-quit pass after
//                      the dialog falls straight through to the drain).
export function shouldConfirmClose(inFlight: boolean, alreadyConfirmed: boolean): boolean {
  return inFlight && !alreadyConfirmed;
}

// After the confirm preventDefaulted the quit, decide whether there is a daemon
// the shell must drain. When there is NOT (the dev path spawns the daemon
// separately, so the shell never owns it), the caller must re-issue app.quit()
// itself — otherwise the cancelled quit is never re-raised and the window hangs
// open. True ⇒ a drain will run and re-quit; false ⇒ caller must quit now.
export function hasDaemonToDrain(args: {
  hasDaemon: boolean;
  spawnedByShell: boolean;
  daemonKilled: boolean;
}): boolean {
  return args.hasDaemon && args.spawnedByShell && !args.daemonKilled;
}
