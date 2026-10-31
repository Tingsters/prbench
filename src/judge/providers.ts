// Judges run through the agent CLIs the user is already signed in to, with
// tools off, hooks off and no saved session, from an empty temp directory, so
// a judging call can't touch the user's repositories or show up as work in
// their session logs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JUDGMENT_SCHEMA } from './rubric.ts';

export interface JudgeReply {
  text: string;
  costUsd?: number;
}

export interface JudgeProvider {
  /** Stable id used in file names and reports, e.g. "claude:opus". */
  id: string;
  family: string;
  ask(prompt: string): Promise<JudgeReply>;
}

async function run(cmd: string[], prompt: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'prbench-judge-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

export function claudeJudge(model = 'opus', timeoutMs = 15 * 60_000): JudgeProvider {
  return {
    id: `claude:${model}`,
    family: 'anthropic',
    ask: (prompt) =>
      withTempDir(async (dir) => {
        const r = await run(
          [
            'claude',
            '-p',
            '--tools',
            '',
            '--model',
            model,
            '--output-format',
            'json',
            '--json-schema',
            JSON.stringify(JUDGMENT_SCHEMA),
            '--no-session-persistence',
            '--settings',
            '{"disableAllHooks":true}',
          ],
          prompt,
          dir,
          timeoutMs,
        );
        if (r.code !== 0) throw new Error(`claude judge failed (${r.code}): ${(r.stderr || r.stdout).slice(-800)}`);
        const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, any>;
        if (out.is_error) throw new Error(`claude judge reported an error: ${String(out.result).slice(0, 800)}`);
        const text = out.structured_output !== undefined ? JSON.stringify(out.structured_output) : String(out.result ?? '');
        return { text, costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : undefined };
      }),
  };
}

export function codexJudge(model?: string, timeoutMs = 15 * 60_000): JudgeProvider {
  return {
    id: `codex:${model ?? 'default'}`,
    family: 'openai',
    ask: (prompt) =>
      withTempDir(async (dir) => {
        const schema = join(dir, 'schema.json');
        const out = join(dir, 'out.json');
        writeFileSync(schema, JSON.stringify(JUDGMENT_SCHEMA));
        const cmd = ['codex', 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--output-schema', schema, '-o', out];
        if (model) cmd.push('-m', model);
        cmd.push('-');
        const r = await run(cmd, prompt, dir, timeoutMs);
        if (r.code !== 0) throw new Error(`codex judge failed (${r.code}): ${(r.stderr || r.stdout).slice(-800)}`);
        return { text: readFileSync(out, 'utf8') };
      }),
  };
}

/** "claude", "claude:sonnet", "codex", "codex:gpt-5.5" -> a provider. */
export function parseJudge(spec: string): JudgeProvider {
  const [name, model] = spec.split(':', 2);
  if (name === 'claude') return claudeJudge(model || 'opus');
  if (name === 'codex') return codexJudge(model || undefined);
  throw new Error(`unknown judge "${spec}" (use claude[:model] or codex[:model])`);
}

/** Pulls the first JSON object out of a reply that may wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fence) return JSON.parse(fence[1]!);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`no JSON in judge reply: ${trimmed.slice(0, 200)}`);
  }
}
