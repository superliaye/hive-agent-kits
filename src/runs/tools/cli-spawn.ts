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
// arrives. Deliberately NO 64 KiB cap on stdout (unlike run-shell, which returns
// one bounded string): a stream's purpose is unbounded incremental delivery; the
// consumer bounds what it forwards.
//
// stderr is exposed symmetric with stdout but ACTIVELY DRAINED here (a
// background pump) so a full stderr pipe never blocks the child — the
// >64 KiB-stderr deadlock — no matter when the consumer reads it. C2b iterates
// the exposed stderr to route diagnostics. `stderr:"ignore"` is NOT used.

import type { ReadableStreamDefaultReader } from "node:stream/web";
import type { CliSpawnerPort, CliSpawnInput, CliSpawnResult } from "../effect/ports.ts";

// The reader type Bun's piped subprocess stdout/stderr yield — the
// `node:stream/web` flavor (not the lib global, which has an incompatible BYOB
// `read()` overload).
type ByteReader = ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;

// Decode a Uint8Array stream reader to a string AsyncIterable, holding multibyte
// chars that straddle a chunk boundary via TextDecoder({stream:true}) + a final
// flush. Reads through the supplied reader so the spawner can also cancel that
// same reader on kill (releasing the OS handle immediately, mirroring the
// probe's explicit pipe cancel). Kept lazy so iteration drives the read.
async function* decodeReader(reader: ByteReader): AsyncIterable<string> {
  const decoder = new TextDecoder();
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
        // Bun's FileSink write/end return Promises that reject (e.g. EOF) if the
        // child closes stdin early — a CLI-backend case (claude/codex may not
        // drain stdin). Swallow on the cleanup path so it can't become an
        // unhandled rejection that crashes the daemon. `.catch(()=>{})` is the
        // sanctioned no-float form (probe.ts drain) — never `void`/a suppression.
        Promise.resolve(proc.stdin.write(stdin)).catch(() => {});
        Promise.resolve(proc.stdin.end()).catch(() => {});
      }

      const stdoutReader = proc.stdout.getReader();
      const stderrReader = proc.stderr.getReader();

      // Cancellation: kill the child on abort (mirrors run-shell's "already
      // aborted vs. add listener" split). Killing closes both pipes (the
      // iterables terminate) and `exited` resolves with the killed code.
      // Additionally cancel BOTH stream readers so the OS handles are released
      // immediately even if the consumer never iterates them, mirroring the
      // probe's explicit pipe cancel on kill. All cleanup is best-effort —
      // already-exited/locked throws are swallowed (no-float gate: `.catch`/
      // try-catch on the cleanup path, never `void`).
      const kill = () => {
        try {
          proc.kill();
        } catch {
          // already exited
        }
        stdoutReader.cancel().catch(() => {});
        stderrReader.cancel().catch(() => {});
      };
      if (signal?.aborted) {
        kill();
      } else {
        signal?.addEventListener("abort", kill);
      }

      // Drain stderr eagerly into a buffer so a full stderr pipe can't block the
      // child while the consumer is busy with stdout. The exposed `stderr`
      // iterable replays the buffered chunks once draining completes — the
      // consumer still gets a string AsyncIterable, decoded by the same helper.
      const stderrChunks: string[] = [];
      const stderrDrained = (async () => {
        for await (const chunk of decodeReader(stderrReader)) stderrChunks.push(chunk);
      })().catch(() => {});
      async function* stderrReplay(): AsyncIterable<string> {
        await stderrDrained;
        for (const chunk of stderrChunks) yield chunk;
      }

      return {
        kind: "spawned",
        stdout: decodeReader(stdoutReader),
        stderr: stderrReplay(),
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
