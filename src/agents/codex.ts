import type { Sandbox } from '../run/sandbox.ts';
import type { AgentRunResult } from './types.ts';
import { codexCommand, codexRunEnv, withCodexAuth } from './codexAuth.ts';
import { runAgentProcess } from './process.ts';
import { startValidationCapture } from './validation.ts';

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export function reasoningEffort(value: string): ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) throw new Error(`Unknown reasoning effort "${value}".`);
  return value as ReasoningEffort;
}

export interface CodexRunOptions {
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  env?: Record<string, string>;
  log?: (message: string) => void;
}

export function codexTerminalEvent(line: string): 'success' | 'failure' | undefined {
  try {
    const event = JSON.parse(line);
    if (event.type === 'turn.completed') return 'success';
    if (event.type === 'turn.failed') return 'failure';
  } catch { /* Diagnostics are not terminal events. */ }
}

/** Consume terminal JSONL events, without retaining tool output or credentials. */
export function parseCodexResult(stdout: string): Partial<AgentRunResult> {
  let inputTokens = 0, outputTokens = 0, numTurns = 0;
  let result: string | undefined;
  let isError = false;
  for (const line of stdout.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') result = e.item.text;
      if (e.type === 'turn.completed') {
        inputTokens += e.usage?.input_tokens ?? 0;
        outputTokens += e.usage?.output_tokens ?? 0;
        numTurns++;
      }
      if (e.type === 'turn.failed') { isError = true; result = e.error?.message ?? result; }
    } catch { /* Non-JSON diagnostics are not results. */ }
  }
  return { result, isError, ...(numTurns ? { inputTokens, outputTokens, numTurns } : {}) };
}

export async function runCodex(sandbox: Sandbox, opts: CodexRunOptions): Promise<AgentRunResult> {
  return withCodexAuth(sandbox.codexHome, async () => {
    const started = Date.now();
    const cmd = [
      ...codexCommand(), 'exec', '--ignore-user-config', '--json', '--color', 'never',
      '--model', opts.model, '-c', `model_reasoning_effort="${opts.reasoningEffort}"`,
      '-c', 'cli_auth_credentials_store="file"', '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"', '--sandbox', 'danger-full-access',
      '--disable', 'apps', '-c', 'apps._default.enabled=false',
      '--disable', 'browser_use', '--disable', 'computer_use',
      '--enable', 'hooks', '--dangerously-bypass-hook-trust',
      '--add-dir', sandbox.gitDir, '-',
    ];
    opts.log?.(`codex exec --model ${opts.model} --reasoning-effort ${opts.reasoningEffort}`);
    const env = codexRunEnv({ ...sandbox.env, ...opts.env });
    const capture = startValidationCapture(sandbox, env);
    const result = await runAgentProcess(cmd, {
      cwd: sandbox.repo,
      env, prompt: opts.prompt, timeoutMs: opts.timeoutMs, terminalEvent: codexTerminalEvent, onLine: capture.line,
    });
    const parsed = parseCodexResult(result.stdout);
    return { ...parsed, validation: capture.finish(result), exitCode: result.exitCode, timedOut: result.timedOut, cleanupTerminated: result.cleanupTerminated, isError: Boolean(parsed.isError || result.exitCode !== 0), durationMs: Date.now() - started, stderr: result.stderr.slice(-4000) };
  });
}
