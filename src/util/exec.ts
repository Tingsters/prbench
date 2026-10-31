export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {},
): ExecResult {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.input === undefined ? 'ignore' : Buffer.from(opts.input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Runs git and returns trimmed stdout, throwing with stderr on failure. */
export function git(args: string[], cwd?: string): string {
  const r = exec(['git', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout.trimEnd();
}
