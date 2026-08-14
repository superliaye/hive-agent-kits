export type GitProcessResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
};

export type GitProcess = {
  run(
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ): Promise<GitProcessResult>;
};

export class GitProcessFailure extends Error {
  override readonly name = "GitProcessFailure";
  constructor(
    readonly args: readonly string[],
    readonly result: GitProcessResult,
    readonly timedOut: boolean,
  ) {
    super(timedOut ? "git command timed out" : "git command failed");
  }
}

export function productionGitProcess(): GitProcess {
  return {
    async run(args, options = {}) {
      const child = Bun.spawn(["git", ...args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        // Keep the Daemon's HOME and configured credential helpers available,
        // while making an interactive credential prompt impossible.
        env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
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
  };
}
