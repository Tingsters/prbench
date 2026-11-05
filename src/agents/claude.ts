// Runs Claude Code headlessly inside a sandbox.
//
// Sandboxes have their own HOME, so Claude Code can't use the user's normal
// login there. Copying ~/.claude/.credentials.json in would be unsafe: a token
// refresh inside the sandbox could sign the user out. Instead runs use a
// long-lived token from `claude setup-token` (or an API key), passed in the
// environment.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Sandbox } from '../run/sandbox.ts';
import type { AgentRunResult } from './types.ts';
import { startValidationCapture } from './validation.ts';
import { runAgentProcess } from './process.ts';

export const TOKEN_FILE = join(homedir(), '.prbench', 'claude-oauth-token');

type Env = Record<string, string | undefined>;

/** Where sandboxed runs get Claude Code credentials from, in priority order. */
function claudeAuthSource(env: Env): { source: string; credentials: Record<string, string> } | undefined {
  for (const name of ['PRBENCH_CLAUDE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const token = env[name]?.trim();
    if (token) return { source: name, credentials: { CLAUDE_CODE_OAUTH_TOKEN: token } };
  }
  if (env.ANTHROPIC_API_KEY?.trim())
    return { source: 'ANTHROPIC_API_KEY', credentials: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } };
  const file = claudeTokenFile(env);
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (token) return { source: file, credentials: { CLAUDE_CODE_OAUTH_TOKEN: token } };
  }
  return undefined;
}

function claudeTokenFile(env: Env): string {
  return env.PRBENCH_CLAUDE_TOKEN_FILE || TOKEN_FILE;
}

/** Credentials for Claude Code inside a sandbox, from the environment or ~/.prbench/claude-oauth-token. */
export function claudeAuthEnv(env: Env = process.env): Record<string, string> {
  const found = claudeAuthSource(env);
  if (found) return found.credentials;
  throw new Error(
    'No Claude Code credentials for sandboxed runs. Run `claude setup-token` and save the token to ' +
      `${claudeTokenFile(env)} (or set PRBENCH_CLAUDE_OAUTH_TOKEN, or ANTHROPIC_API_KEY).`,
  );
}

/** Which credential source sandboxed runs would use: a variable name or the token file path, never the secret. */
export function claudeAuthStatus(env: Env = process.env): { ok: boolean; source: string } {
  const found = claudeAuthSource(env);
  return found ? { ok: true, source: found.source } : { ok: false, source: 'none' };
}

/** Stores a `claude setup-token` token for sandboxed runs (owner-only file). Returns the file path. */
export function saveClaudeToken(token: string, env: Env = process.env): string {
  const value = token.trim();
  if (!value) throw new Error('The Claude token is empty.');
  if (/\s/.test(value)) throw new Error('The Claude token must be a single line without spaces.');
  const file = claudeTokenFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, value + '\n', { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

/**
 * Environment for a Claude Code process: the given base without any inherited
 * Anthropic or Claude Code settings or credentials, plus only the chosen auth.
 */
export function claudeProcessEnv(base: Env, auth: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    const u = k.toUpperCase();
    if (v === undefined || u.startsWith('ANTHROPIC_') || u.startsWith('CLAUDE_CODE_') || u === 'CLAUDECODE') continue;
    if (u === 'CLAUDE_CONFIG_DIR' || u.startsWith('PRBENCH_CLAUDE_')) continue;
    env[k] = v;
  }
  return { ...env, ...auth };
}

/** An MCP configuration with no servers, used with --strict-mcp-config. */
export const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

/** Claude Code stream-json ends a turn with a `result` event; anything after it is CLI cleanup. */
export function claudeTerminalEvent(line: string): 'success' | 'failure' | undefined {
  try {
    const event = JSON.parse(line);
    if (event?.type === 'result') return event.is_error ? 'failure' : 'success';
  } catch {
    /* Diagnostics are not terminal events. */
  }
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export function claudeEffort(value: string): ClaudeEffort {
  if (!(CLAUDE_EFFORTS as readonly string[]).includes(value)) throw new Error(`Unknown Claude effort "${value}".`);
  return value as ClaudeEffort;
}

/** The command that starts Claude Code. PRBENCH_CLAUDE_COMMAND (a JSON array) overrides it, e.g. for tests. */
export function claudeCommand(env: Record<string, string | undefined> = process.env): string[] {
  if (env.PRBENCH_CLAUDE_COMMAND) return JSON.parse(env.PRBENCH_CLAUDE_COMMAND) as string[];
  return ['claude'];
}

export interface ClaudeRunOptions {
  prompt: string;
  model: string;
  /** Claude Code's --effort level; omitted means the CLI default. */
  effort?: string;
  /** Tool rules Claude Code may use without asking; everything else is denied. */
  allowedTools: string[];
  /** Tools the agent may not use at all. */
  disallowedTools?: string[];
  /** Restricts the built-in tool set (`--tools`); "" disables every tool. */
  tools?: string;
  /** Directories outside the checkout the agent may read and use. */
  addDirs?: string[];
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Permission mode; defaults to acceptEdits. */
  permissionMode?: string;
  /** Added to the sandbox environment. */
  env?: Record<string, string>;
  log?: (message: string) => void;
}

export type ClaudeRunResult = AgentRunResult & {
  /** The stream-json `system`/`init` event, when Claude Code printed one. */
  init?: Record<string, unknown>;
  /** Tool calls the agent made, from the stream. */
  toolCalls?: number;
};

function parseResult(stdout: string): Partial<ClaudeRunResult> {
  // stream-json prints one event per line; the last `result` event is the outcome.
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as Record<string, any>;
      if (j.type !== 'result') continue;
      const u = j.usage ?? {};
      return {
        result: typeof j.result === 'string' ? j.result : undefined,
        isError: Boolean(j.is_error),
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
        inputTokens:
          typeof u.input_tokens === 'number'
            ? u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            : undefined,
        ...(typeof u.cache_read_input_tokens === 'number' ? { cachedInputTokens: u.cache_read_input_tokens } : {}),
        outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
        numTurns: typeof j.num_turns === 'number' ? j.num_turns : undefined,
      };
    } catch {
      // not JSON; keep looking
    }
  }
  return {};
}

/** The init event and the number of tool calls in a stream-json transcript. */
export function parseClaudeStream(stdout: string): { init?: Record<string, unknown>; toolCalls: number } {
  let init: Record<string, unknown> | undefined;
  let toolCalls = 0;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      if (event.type === 'system' && event.subtype === 'init' && !init) init = event;
      if (event.type === 'assistant' && Array.isArray(event.message?.content))
        toolCalls += event.message.content.filter((c: any) => c?.type === 'tool_use' || c?.type === 'server_tool_use').length;
    } catch {
      // not JSON
    }
  }
  return { init, toolCalls };
}

/** Writer flags shared by every sandboxed Claude Code run: settings come only from the sandbox HOME, and no MCP servers load. */
export function claudeIsolationFlags(): string[] {
  return ['--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG];
}

export async function runClaude(sandbox: Sandbox, opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  const cmd = [
    ...claudeCommand(),
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    opts.model,
    ...(opts.effort ? ['--effort', claudeEffort(opts.effort)] : []),
    ...claudeIsolationFlags(),
    '--permission-mode',
    opts.permissionMode ?? 'acceptEdits',
  ];
  if (opts.tools !== undefined) cmd.push('--tools', opts.tools);
  if (opts.allowedTools.length) cmd.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.disallowedTools?.length) cmd.push('--disallowedTools', opts.disallowedTools.join(','));
  for (const dir of opts.addDirs ?? []) cmd.push('--add-dir', dir);
  if (opts.maxBudgetUsd !== undefined) cmd.push('--max-budget-usd', String(opts.maxBudgetUsd));
  opts.log?.(`claude ${cmd.slice(claudeCommand().length).join(' ')}`);

  const env = claudeProcessEnv({ ...sandbox.env, ...opts.env }, claudeAuthEnv());
  const capture = startValidationCapture(sandbox, env);
  const executionStarted = performance.now();
  const execution = await runAgentProcess(cmd, {
    cwd: sandbox.repo,
    env,
    prompt: opts.prompt,
    timeoutMs: opts.timeoutMs ?? 45 * 60_000,
    terminalEvent: claudeTerminalEvent,
    onLine: capture.line,
  });
  const writerMs = performance.now() - executionStarted;
  const captureStarted = performance.now();
  const { stdout, stderr, exitCode, timedOut } = execution;
  const parsed = parseResult(stdout);
  const stream = parseClaudeStream(stdout);
  const validation = capture.finish(execution);
  return {
    exitCode,
    timedOut,
    cleanupTerminated: execution.cleanupTerminated,
    rawExitCode: execution.rawExitCode,
    isError: Boolean(parsed.isError || exitCode !== 0),
    ...parsed,
    ...stream,
    durationMs: Date.now() - started,
    stageTimings: { authWaitMs: 0, writerMs, collectionEvidenceMs: performance.now() - captureStarted },
    stderr: stderr.slice(-4000),
    validation,
  };
}

/** A short explanation of a run that didn't produce a PR, for error messages. */
export function describeRun(r: AgentRunResult): string {
  const parts = [`exit ${r.exitCode}`];
  if (r.timedOut) parts.push('timed out');
  if (r.isError) parts.push('reported an error');
  if (r.result) parts.push(`final message: ${r.result.slice(0, 600)}`);
  if (r.stderr.trim()) parts.push(`stderr: ${r.stderr.trim().slice(-600)}`);
  return parts.join('; ');
}
