import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAuthHome, codexRunEnv, withCodexAuth } from '../src/agents/codexAuth.ts';
import { codexTerminalEvent, parseCodexResult } from '../src/agents/codex.ts';
import { loadCase } from '../src/schema/case.ts';
import { runCase } from '../src/run/runner.ts';
import { codexSystem } from '../src/systems/codex.ts';
import { PR_PROMPT } from '../src/systems/agentShared.ts';
import { parseJudge } from '../src/judge/providers.ts';
import { cleanupTemps, copyExample, EXAMPLE, CASES, ROOT, tempDir } from './helpers.ts';
import { exec } from '../src/util/exec.ts';
import { normalizeBody } from '../src/judge/normalize.ts';
import { RUBRIC_KEYS } from '../src/judge/rubric.ts';
import { ARTIFACT_SCHEMA } from '../src/schema/artifact.ts';
import { runAgentProcess } from '../src/agents/process.ts';
import { createSandbox } from '../src/run/sandbox.ts';
import { tracetoonDraft } from '../src/systems/tracetoon.ts';

afterAll(cleanupTemps);
const saved: Record<string, string | undefined> = {};
function env(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v; }
}
let auth: string, log: string;
beforeAll(() => {
  auth = tempDir(); log = join(tempDir(), 'calls.jsonl');
  writeFileSync(join(auth, 'auth.json'), '{"generation":1}');
  const skill = tempDir(); writeFileSync(join(skill, 'SKILL.md'), '# test skill'); writeFileSync(join(skill, 'VERSION'), '0.0.0-test');
  env({ PRBENCH_CODEX_AUTH_HOME: auth, PRBENCH_CODEX_COMMAND: JSON.stringify([process.execPath, join(import.meta.dir, 'fixtures', 'fake-codex.ts')]),
    PRBENCH_TRACETOON_COMMAND: JSON.stringify([process.execPath, join(import.meta.dir, 'fixtures', 'fake-tracetoon.ts')]),
    PRBENCH_TRACETOON_SKILL: skill, FAKE_CODEX_LOG: log, OPENAI_API_KEY: 'test-only-unused', CODEX_SESSION_ID: 'test-only-parent', CODEX_THREAD_ID: 'test-only-thread', CODEX_DAEMON_SHUTDOWN_FILE: 'test-only-control' });
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s));

describe('Codex credentials', () => {
  test('child environments retain only their explicit Codex home', () => {
    expect(codexRunEnv({ CODEX_HOME: 'sandbox-home', CODEX_SESSION_ID: 'parent', CODEX_THREAD_ID: 'parent-thread', CODEX_DAEMON_SHUTDOWN_SOCKET: 'parent-control', OPENAI_API_KEY: 'unused', OTHER: 'safe' })).toEqual({ CODEX_HOME: 'sandbox-home', OTHER: 'safe' });
  });
  test('separate cache, serialized refreshes and cleanup on failure', async () => {
    const source = tempDir(); writeFileSync(join(source, 'auth.json'), '{"generation":1}');
    const first = tempDir(), second = tempDir();
    const opts = { env: { PRBENCH_CODEX_AUTH_HOME: source } };
    const seen: number[] = [];
    await Promise.all([first, second].map((home) => withCodexAuth(home, async () => {
      const p = join(home, 'auth.json'); const a = JSON.parse(readFileSync(p, 'utf8'));
      seen.push(a.generation); await new Promise((r) => setTimeout(r, 30));
      writeFileSync(p, JSON.stringify({ generation: a.generation + 1 }));
    }, opts)));
    expect(seen).toEqual([1, 2]);
    expect(JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8'))).toEqual({ generation: 3 });
    expect(existsSync(join(first, 'auth.json'))).toBe(false);
    await expect(withCodexAuth(second, async () => { throw new Error('failure'); }, opts)).rejects.toThrow('failure');
    expect(existsSync(join(second, 'auth.json'))).toBe(false);
    expect(existsSync(join(source, 'prbench.lock'))).toBe(false);
  });

  test('missing login and interactive-cache reuse are rejected', async () => {
    const dir = tempDir();
    expect(() => codexAuthHome({ PRBENCH_CODEX_AUTH_HOME: dir, CODEX_HOME: dir })).toThrow(/separate benchmark/);
    await expect(withCodexAuth(tempDir(), async () => {}, { env: { PRBENCH_CODEX_AUTH_HOME: dir } })).rejects.toThrow(/auth codex/);
  });
});

describe('Codex systems', () => {
  test('executable discovery stays inside the fake GitHub environment', () => {
    const sandbox = createSandbox(loadCase(EXAMPLE), { parent: tempDir() });
    try {
      const path = Object.entries(sandbox.env).find(([key]) => key.toUpperCase() === 'PATH')![1];
      const found = Bun.which('gh', { PATH: path });
      expect(found?.toLowerCase()).toStartWith(sandbox.bin.toLowerCase());
      const version = exec([found!, '--version'], { cwd: sandbox.repo, env: sandbox.env });
      expect(version.code).toBe(0); expect(version.stdout).toContain('prbench fake');
    } finally { sandbox.dispose(); }
  });

  test('same prompt/model/effort and isolation for native and Tracetoon flows', async () => {
    const loaded = loadCase(EXAMPLE);
    env({ FAKE_CODEX_MODE: 'native' });
    const output = tempDir();
    const native = await runCase(loaded, codexSystem(false, { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }), { sandboxParent: tempDir(), outDir: output });
    const baseline = calls().at(-1);
    env({ FAKE_CODEX_MODE: 'tracetoon' });
    const tool = await runCase(loaded, codexSystem(true, { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }), { sandboxParent: tempDir(), keepSandbox: true });
    const plugin = calls().at(-1);
    for (const call of [baseline, plugin]) {
      expect(call.prompt).toBe(PR_PROMPT);
      expect(call.args).toEqual(expect.arrayContaining(['--model', 'gpt-6.1-sol', 'model_reasoning_effort="medium"', '--ignore-user-config', 'apps', 'apps._default.enabled=false', 'browser_use', 'computer_use', 'skip_host_skill_discovery', 'remote_plugin']));
      expect(call.authPresent).toBe(true); expect(call.apiKeyPresent).toBe(false); expect(call.authSourceVisible).toBe(false);
      expect(call.parentCodexStateVisible).toBe(false);
      expect(call.home).not.toBe(process.env.HOME);
      expect(existsSync(join(call.codexHome, 'auth.json'))).toBe(false);
    }
    expect(baseline.tracetoonOff).toBe('0'); expect(plugin.tracetoonOff).toBeUndefined();
    expect(existsSync(join(plugin.cwd, '.agents', 'skills', 'tracetoon', 'SKILL.md'))).toBe(true);
    expect(exec(['git', 'status', '--porcelain'], { cwd: plugin.cwd }).stdout).toBe('');
    expect(existsSync(join(tool.sandboxRoot!, 'codex', 'hooks.json'))).toBe(true);
    expect(native.artifact.meta).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium', toolVersion: '9.8.7', inputTokens: 100, outputTokens: 20 });
    expect(native.artifact.meta.costUsd).toBeUndefined();
    expect(tool.artifact.meta).toMatchObject({ agent: 'codex', tool: 'tracetoon', toolVersion: '0.0.0-test' });
    for (const a of [native.artifact, tool.artifact]) {
      expect(a.validation?.commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'bun test', exitCode: 0, output: expect.stringContaining('2 pass') })]));
      expect(a.validation?.commands[0]?.before?.fingerprint).toHaveLength(64);
    }
    expect(JSON.parse(readFileSync(join(output, loaded.case.id, 'codex-native.json'), 'utf8')).validation.commands[0].output).toContain('2 pass');
    const mismatched = exec([process.execPath, join(ROOT, 'src', 'cli.ts'), 'run', '-s', 'codex-native', '--cases', CASES, '--model', 'gpt-6.1-terra', '--skip-existing', '-o', output], { cwd: ROOT, env: { ...process.env } });
    expect(mismatched.code).toBe(1); expect(mismatched.stderr).toContain('different model or reasoning');
  });

  test('failure without a draft is reported and a fictitious USD cap is rejected', async () => {
    env({ FAKE_CODEX_MODE: 'failed' });
    await expect(runCase(loadCase(EXAMPLE), codexSystem(false), { sandboxParent: tempDir() })).rejects.toThrow(/simulated provider failure/);
    await expect(runCase(loadCase(EXAMPLE), codexSystem(false, { maxBudgetUsd: 1 }), { sandboxParent: tempDir() })).rejects.toThrow(/no USD spending-cap/);
  });
});

test('Codex usage does not double-count cached input, and failed turns remain errors', () => {
  expect(parseCodexResult('{"type":"turn.completed"}').inputTokens).toBeUndefined();
  expect(parseCodexResult('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n{"type":"turn.completed"}').inputTokens).toBeUndefined();
  expect(parseCodexResult('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}')).toMatchObject({inputTokens:0,outputTokens:0});
  expect(parseCodexResult('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":5}}')).toMatchObject({ inputTokens: 100, outputTokens: 5 });
  expect(parseCodexResult('{"type":"turn.failed","error":{"message":"unavailable"}}')).toMatchObject({ isError: true, result: 'unavailable' });
});

test('Codex attribution is removed without stripping the substantive description', () => {
  expect(normalizeBody('Codex integration uses OAuth.\n\n🤖 Generated with [Codex](https://example.invalid)')).toBe('Codex integration uses OAuth.');
});

test('prose AI-review disclosures cannot reveal the system to a blind judge', () => {
  const content = 'Tracetoon adds an independent PR review stage.';
  for (const disclosure of [
    'Description prepared from session logs with Tracetoon and independently reviewed by AI agents. No human review was captured.',
    'This description was prepared with AI from session logs and independently reviewed by an AI agent.\nNo human author review was captured.',
    'Implementation assisted by Claude Code. Description drafted from session logs with Tracetoon.',
  ]) expect(normalizeBody(`${content}\n\n${disclosure}`)).toBe(content);
});

test('an empty latest Tracetoon run cannot hide an earlier ready draft', () => {
  const gitDir = tempDir(), runs = join(gitDir, 'tracetoon', 'runs');
  const ready = join(runs, '20260101-000000'), empty = join(runs, '20260101-000001');
  mkdirSync(ready, { recursive: true }); mkdirSync(empty);
  writeFileSync(join(ready, 'title.txt'), 'A finished draft');
  writeFileSync(join(ready, 'final-body.md'), 'The finished body.');
  writeFileSync(join(ready, 'task.json'), '{"state":"ready"}');
  writeFileSync(join(runs, 'latest'), '20260101-000001');
  expect(tracetoonDraft(gitDir)).toMatchObject({ run: '20260101-000000', title: 'A finished draft', body: 'The finished body.', state: 'ready', rendered: true });
  writeFileSync(join(empty, 'title.txt'), 'The selected draft');
  writeFileSync(join(empty, 'body.md'), 'The selected body.');
  expect(tracetoonDraft(gitDir)).toMatchObject({ run: '20260101-000001', title: 'The selected draft', rendered: false });
});

test('an exited agent does not wait for a background child to close inherited pipes', async () => {
  const script = join(tempDir(), 'background.ts');
  writeFileSync(script, 'Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 6000)"], { stdout: "inherit", stderr: "inherit" }); console.log("finished"); process.exit(0);');
  const started = Date.now();
  const result = await runAgentProcess([process.execPath, script], { cwd: ROOT, prompt: '', timeoutMs: 10_000 });
  expect(result.exitCode).toBe(0); expect(result.stdout).toContain('finished');
  expect(Date.now() - started).toBeLessThan(4000);
});

test('a completed Codex turn can end lingering CLI cleanup without becoming a model failure', async () => {
  const result = await runAgentProcess([process.execPath, '-e', 'console.log(JSON.stringify({type:"turn.completed"}));setTimeout(()=>{},15000)'], {
    cwd: ROOT, prompt: '', timeoutMs: 10_000, terminalEvent: codexTerminalEvent,
  });
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, cleanupTerminated: true });
});

test('explicit model and effort make distinct isolated judge identities', async () => {
  const sol = parseJudge('codex:gpt-6.1-sol@medium'); const terra = parseJudge('codex:gpt-6.1-terra@medium');
  expect(sol.id).toBe('codex:gpt-6.1-sol@medium'); expect(terra.id).not.toBe(sol.id);
  expect(parseJudge('codex:gpt-6.1-sol@high').id).not.toBe(sol.id);
  // Claude judges take an explicit effort too; a bare effort without a model does not.
  expect(parseJudge('claude:opus@medium').id).toBe('claude:opus@medium');
  expect(() => parseJudge('claude@medium')).toThrow(/invalid judge/);
  env({ FAKE_CODEX_MODE: 'judge', FAKE_CODEX_JUDGMENT: '{"result":"test"}' });
  expect(await sol.ask('judge this pair')).toEqual({ text: '{"result":"test"}' });
  const call = calls().at(-1);
  expect(call.args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ephemeral', 'read-only', 'hooks', 'model_reasoning_effort="medium"', 'apps', 'apps._default.enabled=false', 'shell_tool', 'plugins', 'view_image']));
  expect(call.authPresent).toBe(true); expect(existsSync(join(call.codexHome, 'auth.json'))).toBe(false);
  expect(call.apiKeyPresent).toBe(false); expect(call.authSourceVisible).toBe(false);
});

test('dev-only judging excludes held-out artifacts and saves the selected scope', () => {
  const dev = copyExample('development');
  const held = copyExample('held-out', (c) => { c.split = 'test'; c.title = 'DO NOT JUDGE THIS CASE'; });
  cpSync(held.dir, join(dev.root, 'held-out'), { recursive: true });
  const output = tempDir(), artifacts = join(output, 'artifacts');
  for (const c of ['development', 'held-out']) {
    mkdirSync(join(artifacts, c), { recursive: true });
    for (const system of ['codex-native', 'codex-tracetoon']) writeFileSync(join(artifacts, c, `${system}.json`), JSON.stringify({
      schema: ARTIFACT_SCHEMA, case: c, system, title: 'A draft', body: 'A change.', base: 'a'.repeat(40), commits: [], diff: '',
      meta: { tool: system, startedAt: '2026-01-01T00:00:00Z', durationMs: 1 },
    }));
  }
  const side = { factualErrors: [], unsupportedClaims: [], claimAssessments: [], claimsCovered: [], contextCovered: [], uncertaintiesRespected: [], trapsHit: [], rubric: Object.fromEntries(RUBRIC_KEYS.map((key) => [key, 1])), notes: '' };
  env({ FAKE_CODEX_MODE: 'judge', FAKE_CODEX_JUDGMENT: JSON.stringify({ A: side, B: side, preferred: 'tie', preferenceDependsOnMissingEvidence: false, reason: 'test' }) });
  const result = exec([process.execPath, join(ROOT, 'src', 'cli.ts'), 'judge', '--cases', dev.root, '--split', 'dev', '--systems', 'codex-native,codex-tracetoon', '--judges', 'codex:gpt-6.1-sol@medium', '--artifacts', artifacts, '-o', output], { cwd: ROOT, env: { ...process.env } });
  expect(result.code).toBe(0);
  const plan = JSON.parse(readFileSync(join(output, 'judging.json'), 'utf8'));
  expect(plan.cases).toEqual(['development']);
  const pairs = JSON.parse(readFileSync(join(output, 'pairs.json'), 'utf8'));
  expect(pairs).toHaveLength(1); expect(pairs[0].case).toBe('development');
  expect(calls().slice(-2).some((call) => call.prompt.includes('DO NOT JUDGE THIS CASE'))).toBe(false);
});

test('judges retain the completed stream reply when the CLI output file is missing', async () => {
  const reply = JSON.stringify({ retained: 'completed structured stream' });
  env({ FAKE_CODEX_MODE: 'nothing', FAKE_CODEX_SKIP_OUTPUT_FILE: '1', FAKE_CODEX_FINAL_MESSAGE: reply });
  try {
    expect((await parseJudge('codex:gpt-6.1-sol@medium').ask('Synthetic diagnostic')).text).toBe(reply);
    env({ FAKE_CODEX_FINAL_MESSAGE: '' });
    await expect(parseJudge('codex:gpt-6.1-sol@medium').ask('Synthetic missing reply')).rejects.toThrow('no structured reply');
    expect(existsSync(join(auth, 'prbench.lock'))).toBe(false);
  } finally {
    env({ FAKE_CODEX_SKIP_OUTPUT_FILE: '0', FAKE_CODEX_FINAL_MESSAGE: 'done' });
  }
});
