export type GitProcessResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
};

export type GitProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  stdin?: Uint8Array;
};

export type GitProcess = {
  run(args: readonly string[], options?: GitProcessOptions): Promise<GitProcessResult>;
};

export class GitProcessFailure extends Error {
  override readonly name = "GitProcessFailure";
  constructor(
    readonly args: readonly string[],
    readonly result: GitProcessResult,
    readonly timedOut: boolean,
    readonly budgetExceeded = false,
  ) {
    super(timedOut ? "git command timed out" : "git command failed");
  }
}

export function productionGitProcess(): GitProcess {
  const STDERR_LIMIT = 64 * 1024;
  const DEFAULT_STDOUT_LIMIT = 64 * 1024 * 1024;
  const KILL_GRACE_MS = 100;
  const ownsProcessGroup = process.platform !== "win32";
  const spawnGit = (args: readonly string[], options: GitProcessOptions) =>
    Bun.spawn(["git", ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      // Keep the Daemon's HOME and configured credential helpers available,
      // while making an interactive credential prompt impossible.
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(ownsProcessGroup ? { detached: true } : {}),
    });

  const signal = (child: ReturnType<typeof spawnGit>, processSignal: "SIGTERM" | "SIGKILL") => {
    if (ownsProcessGroup && child.pid > 0) {
      try {
        process.kill(-child.pid, processSignal);
        return;
      } catch {
        // Fall back to the direct child if process groups are unavailable.
      }
    }
    try {
      child.kill(processSignal);
    } catch {
      // The child may already have exited between observation and signalling.
    }
  };

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    limit: number,
    onOverflow?: () => void,
  ): Promise<{ bytes: Uint8Array; overflow: boolean }> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let retained = 0;
    let overflow = false;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = Math.max(0, limit - retained);
      if (remaining > 0) {
        const chunk = next.value.subarray(0, remaining);
        chunks.push(chunk);
        retained += chunk.byteLength;
      }
      if (next.value.byteLength > remaining && !overflow) {
        overflow = true;
        onOverflow?.();
      }
    }
    const bytes = new Uint8Array(retained);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, overflow };
  };

  const collect = async (
    args: readonly string[],
    options: GitProcessOptions,
    stdoutLimit: number,
  ): Promise<GitProcessResult> => {
    const child = spawnGit(args, options);
    let timedOut = false;
    let budgetExceeded = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: "timeout" | "budget") => {
      if (reason === "timeout") timedOut = true;
      else budgetExceeded = true;
      signal(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => signal(child, "SIGKILL"), KILL_GRACE_MS);
      }
    };
    const timer = setTimeout(() => terminate("timeout"), options.timeoutMs ?? 120_000);
    timer.unref();
    try {
      let collected: [
        number,
        { bytes: Uint8Array; overflow: boolean },
        { bytes: Uint8Array; overflow: boolean },
      ];
      try {
        collected = await Promise.all([
          child.exited,
          readStream(child.stdout, stdoutLimit, () => terminate("budget")),
          readStream(child.stderr, STDERR_LIMIT),
        ]);
      } catch (error) {
        signal(child, "SIGKILL");
        if (killTimer) clearTimeout(killTimer);
        await child.exited.catch(() => undefined);
        throw error;
      }
      const [exitCode, stdout, stderr] = collected;
      const result = {
        exitCode,
        stdout: stdout.bytes,
        stderr: new TextDecoder().decode(stderr.bytes),
      };
      if (exitCode !== 0 || timedOut || budgetExceeded) {
        throw new GitProcessFailure(args, result, timedOut, budgetExceeded);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async run(args, options = {}) {
      return collect(args, options, options.maxStdoutBytes ?? DEFAULT_STDOUT_LIMIT);
    },
  };
}
