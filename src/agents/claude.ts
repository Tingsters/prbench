// Runs Claude Code headlessly inside a sandbox.
//
// Sandboxes have their own HOME, so Claude Code can't use the user's normal
// login there. Copying ~/.claude/.credentials.json in would be unsafe: a token
// refresh inside the sandbox could sign the user out. Instead runs use a
// long-lived token from `claude setup-token` (or an API key), passed in the
// environment.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox } from '../run/sandbox.ts';

export const TOKEN_FILE = join(homedir(), '.prbench', 'claude-oauth-token');

/** Credentials for Claude Code inside a sandbox, from the environment or ~/.prbench/claude-oauth-token. */
export function claudeAuthEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = env.PRBENCH_CLAUDE_OAUTH_TOKEN ?? env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) return { CLAUDE_CODE_OAUTH_TOKEN: token.trim() };
  if (env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
  const file = env.PRBENCH_CLAUDE_TOKEN_FILE ?? TOKEN_FILE;
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return { CLAUDE_CODE_OAUTH_TOKEN: t };
  }
  throw new Error(
    'No Claude Code credentials for sandboxed runs. Run `claude setup-token` and save the token to ' +
      `${file} (or set PRBENCH_CLAUDE_OAUTH_TOKEN, or ANTHROPIC_API_KEY).`,
  );
}

/** The command that starts Claude Code. PRBENCH_CLAUDE_COMMAND (a JSON array) overrides it, e.g. for tests. */
export function claudeCommand(env: Record<string, string | undefined> = process.env): string[] {
  if (env.PRBENCH_CLAUDE_COMMAND) return JSON.parse(env.PRBENCH_CLAUDE_COMMAND) as string[];
  return ['claude'];
}

export interface ClaudeRunOptions {
  prompt: string;
  model: string;
  /** Tool rules Claude Code may use without asking; everything else is denied. */
  allowedTools: string[];
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Added to the sandbox environment. */
  env?: Record<string, string>;
  log?: (message: string) => void;
}

export interface ClaudeRunResult {
  exitCode: number;
  timedOut: boolean;
  /** The final message, when Claude Code reported one. */
  result?: string;
  isError: boolean;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  durationMs: number;
  stderr: string;
}

function parseResult(stdout: string): Partial<ClaudeRunResult> {
  // --output-format json prints one JSON object; take the last line that parses.
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as Record<string, any>;
      const u = j.usage ?? {};
      return {
        result: typeof j.result === 'string' ? j.result : undefined,
        isError: Boolean(j.is_error),
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
        inputTokens:
          typeof u.input_tokens === 'number'
            ? u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            : undefined,
        outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
        numTurns: typeof j.num_turns === 'number' ? j.num_turns : undefined,
      };
    } catch {
      // not JSON; keep looking
    }
  }
  return {};
}

export async function runClaude(sandbox: Sandbox, opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  const cmd = [
    ...claudeCommand(),
    '-p',
    '--output-format',
    'json',
    '--model',
    opts.model,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    opts.allowedTools.join(','),
  ];
  if (opts.maxBudgetUsd !== undefined) cmd.push('--max-budget-usd', String(opts.maxBudgetUsd));
  opts.log?.(`claude ${cmd.slice(claudeCommand().length).join(' ')}`);

  const proc = Bun.spawn(cmd, {
    cwd: sandbox.repo,
    env: { ...sandbox.env, ...claudeAuthEnv(), ...opts.env },
    stdin: new Blob([opts.prompt]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 45 * 60_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const parsed = parseResult(stdout);
  return {
    exitCode,
    timedOut,
    isError: parsed.isError ?? exitCode !== 0,
    ...parsed,
    durationMs: Date.now() - started,
    stderr: stderr.slice(-4000),
  };
}

/** A short explanation of a run that didn't produce a PR, for error messages. */
export function describeRun(r: ClaudeRunResult): string {
  const parts = [`exit ${r.exitCode}`];
  if (r.timedOut) parts.push('timed out');
  if (r.isError) parts.push('reported an error');
  if (r.result) parts.push(`final message: ${r.result.slice(0, 600)}`);
  if (r.stderr.trim()) parts.push(`stderr: ${r.stderr.trim().slice(-600)}`);
  return parts.join('; ');
}
