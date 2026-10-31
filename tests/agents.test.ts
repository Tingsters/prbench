import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAuthEnv } from '../src/agents/claude.ts';
import { loadCase } from '../src/schema/case.ts';
import { runCase } from '../src/run/runner.ts';
import { claudeNative } from '../src/systems/claudeNative.ts';
import { AGENT_TOOLS, PR_PROMPT } from '../src/systems/agentShared.ts';
import { tracetoonSystem } from '../src/systems/tracetoon.ts';
import { cleanupTemps, EXAMPLE, tempDir } from './helpers.ts';

afterAll(cleanupTemps);

const fixtures = join(import.meta.dir, 'fixtures');
const saved: Record<string, string | undefined> = {};
const setEnv = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
};
let log: string;

beforeAll(() => {
  log = join(tempDir(), 'claude-calls.jsonl');
  const skill = tempDir('prbench-skill-');
  mkdirSync(join(skill, 'bin'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# fake skill\n');
  writeFileSync(join(skill, 'VERSION'), '0.0.0-test\n');
  setEnv({
    PRBENCH_CLAUDE_COMMAND: JSON.stringify([process.execPath, join(fixtures, 'fake-claude.ts')]),
    PRBENCH_TRACETOON_COMMAND: JSON.stringify([process.execPath, join(fixtures, 'fake-tracetoon.ts')]),
    PRBENCH_TRACETOON_SKILL: skill,
    PRBENCH_CLAUDE_OAUTH_TOKEN: 'test-token',
    FAKE_CLAUDE_LOG: log,
  });
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const calls = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((c) => c.args[0] !== '--version');

describe('claude auth', () => {
  test('prefers an explicit token, then an API key, then the token file', () => {
    expect(claudeAuthEnv({ PRBENCH_CLAUDE_OAUTH_TOKEN: ' t1 \n', ANTHROPIC_API_KEY: 'k' })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't1' });
    expect(claudeAuthEnv({ ANTHROPIC_API_KEY: 'k' })).toEqual({ ANTHROPIC_API_KEY: 'k' });
    const file = join(tempDir(), 'token');
    writeFileSync(file, 'from-file\n');
    expect(claudeAuthEnv({ PRBENCH_CLAUDE_TOKEN_FILE: file })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'from-file' });
    expect(() => claudeAuthEnv({ PRBENCH_CLAUDE_TOKEN_FILE: join(tempDir(), 'missing') })).toThrow(/claude setup-token/);
  });
});

describe('agent systems', () => {
  const loaded = loadCase(EXAMPLE);

  test('claude-native: the same prompt, a sandboxed home, and the PR captured from gh', async () => {
    setEnv({ FAKE_CLAUDE_MODE: 'native' });
    const { artifact } = await runCase(loaded, claudeNative({ model: 'sonnet' }), { sandboxParent: tempDir() });
    const call = calls().at(-1);
    expect(call.prompt).toBe(PR_PROMPT);
    expect(call.token).toBe('test-token');
    expect(call.tracetoonOff).toBe('0');
    expect(call.home).toContain('prbench-example-greet-default-');
    expect(call.args).toEqual(expect.arrayContaining(['-p', '--model', 'sonnet', '--permission-mode', 'acceptEdits']));
    expect(call.args[call.args.indexOf('--allowedTools') + 1]).toBe(AGENT_TOOLS.join(','));
    expect(call.args).not.toContain('--add-dir');
    expect(call.args[call.args.indexOf('--disallowedTools') + 1]).toBe('PowerShell');

    expect(artifact.system).toBe('claude-native');
    expect(artifact.title).toBe('Fallback to world');
    expect(artifact.body).toContain('Greets world');
    expect(artifact.head).toBe(loaded.case.repo.head!);
    expect(artifact.diff).toContain('+++ b/greet.js');
    expect(artifact.meta).toMatchObject({ tool: 'claude-code-native', toolVersion: '9.9.9', model: 'sonnet', costUsd: 0.42, inputTokens: 150, outputTokens: 20 });
  });

  test('claude-native fails clearly when no PR is opened', async () => {
    setEnv({ FAKE_CLAUDE_MODE: 'nothing' });
    await expect(runCase(loaded, claudeNative(), { sandboxParent: tempDir() })).rejects.toThrow(
      /claude-native opened no PR \(exit 0; final message: done \(nothing\)\)/,
    );
  });

  test('tracetoon: installs into the sandbox, turns comics off, and reads the rendered draft', async () => {
    setEnv({ FAKE_CLAUDE_MODE: 'tracetoon' });
    const parent = tempDir();
    const { artifact, sandboxRoot } = await runCase(loaded, tracetoonSystem({ model: 'opus' }), { sandboxParent: parent, keepSandbox: true });
    const call = calls().at(-1);
    expect(call.prompt).toBe(PR_PROMPT);
    expect(call.tracetoonOff).toBeUndefined();
    expect(JSON.parse(readFileSync(call.tracetoonConfig, 'utf8'))).toEqual({ comic: 'off' });
    expect(existsSync(join(sandboxRoot!, 'home', '.claude', 'skills', 'tracetoon', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(sandboxRoot!, 'home', '.claude', 'settings.json'))).toBe(true);
    const tools: string = call.args[call.args.indexOf('--allowedTools') + 1];
    expect(tools.startsWith(AGENT_TOOLS.join(','))).toBe(true); // same base list as the baseline
    expect(call.args[call.args.indexOf('--disallowedTools') + 1]).toBe('PowerShell');
    expect(tools).toContain('/home/.claude/skills/tracetoon/bin/tracetoon:*)');
    expect(call.args[call.args.indexOf('--add-dir') + 1]).toBe(join(sandboxRoot!, 'home', '.claude', 'skills', 'tracetoon'));

    expect(artifact.title).toBe("Greet 'world' when no name is given");
    expect(artifact.body).toContain('greet() now falls back to world.');
    expect(artifact.meta).toMatchObject({ tool: 'tracetoon', toolVersion: '0.0.0-test', model: 'opus' });
    expect(artifact.meta.notes).toContain('tracetoon run 20260101-000000');
  });

  test('tracetoon fails clearly when it leaves no draft', async () => {
    setEnv({ FAKE_CLAUDE_MODE: 'nothing' });
    await expect(runCase(loaded, tracetoonSystem(), { sandboxParent: tempDir() })).rejects.toThrow(/tracetoon produced no PR draft/);
  });
});
