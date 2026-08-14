export type GitProcessResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
};

export type GitProcessOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };

export type GitArchiveOptions = GitProcessOptions & { maxBytes: number };

export type GitProcess = {
  run(args: readonly string[], options?: GitProcessOptions): Promise<GitProcessResult>;
  runArchive(args: readonly string[], options: GitArchiveOptions): Promise<GitProcessResult>;
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
  const spawnGit = (args: readonly string[], options: GitProcessOptions) =>
    Bun.spawn(["git", ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      // Keep the Daemon's HOME and configured credential helpers available,
      // while making an interactive credential prompt impossible.
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

  return {
    async run(args, options = {}) {
      const child = spawnGit(args, options);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs ?? 120_000);
      timer.unref();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
      ]);
      clearTimeout(timer);
      const result = { exitCode, stdout: new Uint8Array(stdout), stderr };
      if (exitCode !== 0 || timedOut) throw new GitProcessFailure(args, result, timedOut);
      return result;
    },
    async runArchive(args, options) {
      const child = spawnGit(args, options);
      let timedOut = false;
      let budgetExceeded = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs ?? 120_000);
      timer.unref();
      try {
        const reader = child.stdout.getReader();
        const stderr = new Response(child.stderr).text();
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        let readError: unknown;
        while (true) {
          try {
            const next = await reader.read();
            if (next.done) break;
            const nextByteLength = byteLength + next.value.byteLength;
            if (nextByteLength > options.maxBytes) {
              budgetExceeded = true;
              child.kill();
              await reader.cancel();
              break;
            }
            byteLength = nextByteLength;
            chunks.push(next.value);
          } catch (error) {
            readError = error;
            child.kill();
            break;
          }
        }
        const [exitCode, stderrText] = await Promise.all([child.exited, stderr]);
        if (readError) throw readError;
        const stdout = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          stdout.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const result = { exitCode, stdout, stderr: stderrText };
        if (exitCode !== 0 || timedOut || budgetExceeded) {
          throw new GitProcessFailure(args, result, timedOut, budgetExceeded);
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
