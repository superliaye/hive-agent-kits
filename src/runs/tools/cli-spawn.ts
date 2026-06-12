// CLI streaming-spawn adapter — the true external I/O edge a long-lived CLI
// backend (claude/codex) runs through (C2 `cli-dispatch-arm` spawns here).
//
// Sibling of `run-shell.ts`'s `createDefaultShellRunner`, and SHAPE-aligned with
// C1's `bunCommandRunner` (`src/backend-probe/probe.ts`): `Bun.spawn` with a
// string-vector command and `shell:false` (bare spawn — the house security
// stance), ENOENT classified as a `spawn_failed` value (not a throw).
//
// Divergence from the probe: this STREAMS stdout incrementally rather than
// draining it to one string, and exposes the exit as a separate Promise. The
// probe folds the whole lifecycle into one resolved value because it is
// short-lived; a CLI Run's consumer (C2b) maps stdout to RunEvents as it
// arrives. Deliberately NO 64 KiB cap (unlike run-shell, which returns one
// bounded string): a stream's purpose is unbounded incremental delivery; the
// consumer bounds what it forwards.

import type { CliSpawnerPort, CliSpawnInput, CliSpawnResult } from "../effect/ports.ts";

// Decode a Uint8Array ReadableStream to a string AsyncIterable, holding multibyte
// chars that straddle a chunk boundary via TextDecoder({stream:true}) + a final
// flush. Kept lazy so iteration drives the read.
async function* decodeStream(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) yield text;
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export function createDefaultCliSpawner(): CliSpawnerPort {
  return {
    spawn({ command, cwd, signal, stdin }: CliSpawnInput): CliSpawnResult {
      let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
      try {
        proc = Bun.spawn([...command], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: stdin !== undefined ? "pipe" : "ignore",
        });
      } catch (err) {
        return { kind: "spawn_failed", message: err instanceof Error ? err.message : String(err) };
      }

      if (stdin !== undefined && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }

      // Cancellation: kill the child on abort (mirrors run-shell's "already
      // aborted vs. add listener" split). The killed proc closes stdout (the
      // iterable terminates) and `exited` resolves with the killed code. Kill is
      // best-effort — already-exited throws are swallowed (no-float gate: never
      // `void`, always `.catch`/try/catch on the cleanup path).
      const kill = () => {
        try {
          proc.kill();
        } catch {
          // already exited
        }
      };
      if (signal?.aborted) {
        kill();
      } else {
        signal?.addEventListener("abort", kill);
      }

      return {
        kind: "spawned",
        stdout: decodeStream(proc.stdout),
        exit: proc.exited.then((exitCode) => ({ exitCode })),
      };
    },
  };
}

// Memory-mode / disabled spawner: classifies every spawn as failed without
// touching the system — mirrors the probe's `notInstalledRunner`, so memory mode
// never pretends a CLI ran nor spawns a subprocess.
export const memoryCliSpawner: CliSpawnerPort = {
  spawn: () => ({ kind: "spawn_failed", message: "cli spawn disabled" }),
};
