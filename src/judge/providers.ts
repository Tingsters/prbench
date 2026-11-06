// Judges run through the agent CLIs the user is already signed in to, with
// tools off, hooks off and no saved session, from an empty temp directory, so
// a judging call can't touch the user's repositories or show up as work in
// their session logs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JUDGMENT_SCHEMA } from './rubric.ts';
import { codexCommand, codexRunEnv, withCodexAuth } from '../agents/codexAuth.ts';
import { codexTerminalEvent, parseCodexResult, reasoningEffort, type ReasoningEffort } from '../agents/codex.ts';
import { runAgentProcess } from '../agents/process.ts';
import { claudeAuthEnv, claudeCommand, claudeEffort, claudeProcessEnv, claudeTerminalEvent, EMPTY_MCP_CONFIG, type ClaudeEffort } from '../agents/claude.ts';

export interface JudgeReply {
  text: string;
  costUsd?: number;
}

export interface JudgeProvider {
  /** Stable id used in file names and reports, e.g. "claude:opus". */
  id: string;
  family: string;
  /** `schema` narrows the reply shape for this prompt (default: JUDGMENT_SCHEMA). */
  ask(prompt: string, schema?: object): Promise<JudgeReply>;
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'prbench-judge-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

/** Flags that keep a Claude judge from reading settings, hooks, MCP servers, plugins or tools, and from saving a session. */
export function claudeJudgeFlags(): string[] {
  return [
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP_CONFIG,
    '--disable-slash-commands',
    '--no-session-persistence',
    '--settings',
    '{"disableAllHooks":true}',
  ];
}

/**
 * A Claude Code judge. With an effort it runs fully isolated: an empty temp
 * HOME and XDG dirs, no inherited Anthropic or Claude Code environment, only
 * the chosen sandbox credentials, and no settings, MCP servers, plugins,
 * hooks or tools. Without one it keeps the legacy `claude[:model]` contract
 * (the user's own login) so cached judgments stay valid.
 */
export function claudeJudge(model = 'opus', timeoutMs = 15 * 60_000, effort?: ClaudeEffort): JudgeProvider {
  return {
    id: `claude:${model}${effort ? `@${effort}` : ''}`,
    family: 'anthropic',
    ask: (prompt, schema) =>
      withTempDir(async (dir) => {
        const cmd = [...claudeCommand(), '-p'];
        let env: Record<string, string | undefined> | undefined;
        let cwd = dir;
        if (effort) {
          const home = join(dir, 'home');
          cwd = join(dir, 'work');
          for (const d of [home, cwd, join(home, '.config'), join(home, '.local', 'share'), join(home, '.local', 'state'), join(home, '.cache')])
            mkdirSync(d, { recursive: true });
          const base: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(process.env)) {
            const u = k.toUpperCase();
            if (u.startsWith('CODEX_') || ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'TRACETOON_CONFIG'].includes(u) || u.startsWith('TRACETOON_')) continue;
            base[k] = v;
          }
          env = claudeProcessEnv(
            {
              ...base,
              HOME: home,
              USERPROFILE: home,
              APPDATA: join(home, 'AppData', 'Roaming'),
              LOCALAPPDATA: join(home, 'AppData', 'Local'),
              XDG_CONFIG_HOME: join(home, '.config'),
              XDG_DATA_HOME: join(home, '.local', 'share'),
              XDG_STATE_HOME: join(home, '.local', 'state'),
              XDG_CACHE_HOME: join(home, '.cache'),
            },
            claudeAuthEnv(),
          );
          cmd.push('--model', model, '--effort', effort, ...claudeJudgeFlags());
        } else cmd.push('--tools', '', '--model', model, '--no-session-persistence', '--settings', '{"disableAllHooks":true}');
        cmd.push('--output-format', 'json', '--json-schema', JSON.stringify(schema ?? JUDGMENT_SCHEMA));
        const r = await runAgentProcess(cmd, { prompt, cwd, timeoutMs, env, terminalEvent: effort ? claudeTerminalEvent : undefined });
        if (r.timedOut) throw new Error(`claude judge timed out after ${timeoutMs} ms`);
        if (r.exitCode !== 0) throw new Error(`claude judge failed (${r.exitCode}): ${(r.stderr || r.stdout).slice(-800)}`);
        const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, any>;
        if (out.is_error) throw new Error(`claude judge reported an error: ${String(out.result).slice(0, 800)}`);
        const text = out.structured_output !== undefined ? JSON.stringify(out.structured_output) : String(out.result ?? '');
        return { text, costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : undefined };
      }),
  };
}

export function codexJudge(model?: string, timeoutMs = 15 * 60_000, effort?: ReasoningEffort): JudgeProvider {
  return {
    id: `codex:${model ?? 'default'}${effort ? `@${effort}` : ''}`,
    family: 'openai',
    ask: (prompt, schema) =>
      withTempDir(async (dir) => {
        const schemaFile = join(dir, 'schema.json');
        const out = join(dir, 'out.json');
        writeFileSync(schemaFile, JSON.stringify(schema ?? JUDGMENT_SCHEMA));
        const cmd = [...codexCommand(), 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--output-schema', schemaFile, '-o', out];
        if (model) cmd.push('-m', model);
        if (effort) cmd.push('--json', '--ignore-user-config', '--disable', 'hooks', '--disable', 'memories', '--disable', 'multi_agent', '--disable', 'apps', '-c', 'apps._default.enabled=false', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'shell_tool', '--disable', 'view_image', '--disable', 'plugins', '--disable', 'image_generation', '-c', `model_reasoning_effort="${effort}"`, '-c', 'cli_auth_credentials_store="file"', '-c', 'web_search="disabled"');
        cmd.push('-');
        const ask = async (env?: Record<string, string | undefined>) => {
          const r = await runAgentProcess(cmd, { prompt, cwd: dir, timeoutMs, env, terminalEvent: effort ? codexTerminalEvent : undefined });
          if (r.exitCode !== 0) throw new Error(`codex judge failed (${r.exitCode}): ${(r.stderr || r.stdout).slice(-800)}`);
          const parsed = effort ? parseCodexResult(r.stdout) : undefined;
          if (parsed?.isError) throw new Error(`codex judge reported a failed turn: ${parsed.result?.slice(-800) ?? 'no detail'}`);
          const text = existsSync(out) ? readFileSync(out, 'utf8') : parsed?.result;
          if (!text?.trim()) throw new Error(`codex judge produced no structured reply: ${(r.stderr || r.stdout).slice(-800)}`);
          // The pairwise layer still validates JSON, the schema and evidence references.
          return { text };
        };
        if (!effort) return ask(); // Preserve the legacy codex[:model] judge contract/cache.
        const home = join(dir, 'home');
        const codexHome = join(dir, 'codex');
        mkdirSync(home, { recursive: true });
        return withCodexAuth(codexHome, () => ask(codexRunEnv({ ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home,
          APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
          XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
        })));
      }),
  };
}

/** "claude", "claude:sonnet", "claude:model@effort", "codex", "codex:gpt-5.5", "codex:model@effort" -> a provider. */
export function parseJudge(spec: string): JudgeProvider {
  const [provider, effort, ...extra] = spec.split('@');
  const [name, model, ...modelExtra] = provider!.split(':');
  if (extra.length || modelExtra.length || (effort !== undefined && (!effort || (name !== 'codex' && name !== 'claude') || !model))) throw new Error(`invalid judge "${spec}"; use codex:model@effort or claude:model@effort`);
  if (name === 'claude') return claudeJudge(model || 'opus', undefined, effort ? claudeEffort(effort) : undefined);
  if (name === 'codex') return codexJudge(model || undefined, undefined, effort ? reasoningEffort(effort) : undefined);
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
