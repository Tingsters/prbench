import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_SCHEMA, type PRArtifact } from '../src/schema/artifact.ts';
import { FACTS_SCHEMA, loadCase, type Facts } from '../src/schema/case.ts';
import { normalizeBody, wordCount } from '../src/judge/normalize.ts';
import { combine, judgePair, judgmentPath, type StoredJudgment } from '../src/judge/pairwise.ts';
import { extractJson, parseJudge, type JudgeProvider } from '../src/judge/providers.ts';
import { buildPrompt, checkJudgment, judgmentSchema, JUDGMENT_SCHEMA, PREPARATION_NOTE, RUBRIC_KEYS, RUBRIC_VERSION, type Judgment, type SideJudgment } from '../src/judge/rubric.ts';
import { sessionEvidence, sessionItems } from '../src/judge/evidence.ts';
import { agreedResults, buildReport, reportMarkdown } from '../src/report.ts';
import { bootstrapMeanCI, cohenKappa, signTest } from '../src/stats.ts';
import { parseBudget } from '../src/systems/agentShared.ts';
import { cleanupTemps, copyExample, EXAMPLE, ROOT, tempDir } from './helpers.ts';
import { exec } from '../src/util/exec.ts';

afterAll(cleanupTemps);

const facts: Facts = {
  schema: FACTS_SCHEMA,
  claims: ['greet() falls back to world', 'blank names fall back too'],
  context: ['users saw "Hello, undefined!"'],
  uncertainties: ['trimming is untested'],
  traps: ['claims null is special'],
};

const side = (over: Partial<SideJudgment> = {}): SideJudgment => ({
  factualErrors: [],
  unsupportedClaims: [],
  claimAssessments: [
    ...(over.factualErrors ?? []).map((claim) => ({ claim, status: 'contradicted' as const, evidenceRefs: ['D'], reason: 'Fixture contradiction' })),
    ...(over.unsupportedClaims ?? []).map((claim) => ({ claim, status: 'unsupported' as const, evidenceRefs: ['D'], reason: 'Fixture overclaim' })),
  ],
  claimsCovered: [],
  contextCovered: [],
  uncertaintiesRespected: [],
  trapsHit: [],
  rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 1])) as SideJudgment['rubric'],
  notes: '',
  ...over,
});

const artifact = (system: string, body: string): PRArtifact => ({
  schema: ARTIFACT_SCHEMA,
  case: 'example-greet-default',
  system,
  title: 'Greet world by default',
  body,
  base: 'a'.repeat(40),
  commits: [{ message: 'Greet world' }],
  diff: 'diff --git a/greet.js b/greet.js\n+fallback\n',
  meta: { tool: system, startedAt: '2026-01-01T00:00:00Z', durationMs: 1 },
});

describe('normalize', () => {
  test('strips tool markers, comics and attribution, keeps the description', () => {
    const body = [
      '<!-- tracetoon:start -->',
      'The fix.',
      '',
      '<p align="center"><img src="x.png" alt="comic" width="760"></p>',
      '',
      '<details>',
      '<summary>Comic transcript</summary>',
      '1. Panel',
      '</details>',
      '',
      '<sub>Assisted-by: Claude Code · drafted with Tracetoon</sub>',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      '<!-- tracetoon:meta {"v":1} -->',
      '<!-- tracetoon:end -->',
    ].join('\r\n');
    expect(normalizeBody(body)).toBe('The fix.');
    expect(wordCount('a  b\nc')).toBe(3);
  });

  test('keeps ordinary details blocks and images-free text', () => {
    expect(normalizeBody('Intro\n\n<details><summary>Logs</summary>\nx\n</details>')).toContain('<summary>Logs</summary>');
  });
});

describe('rubric', () => {
  test('the prompt numbers fact-sheet items and fences both descriptions', () => {
    const p = buildPrompt({ caseTitle: 'T', facts, commits: ['c1\nbody'], diff: 'D'.repeat(20), a: { title: 'ta', body: 'ba' }, b: { title: 'tb', body: 'bb' }, diffBudget: 10 });
    expect(p).toContain('C2. blank names fall back too');
    expect(p).toContain('T1. claims null is special');
    expect(p).toContain('<<<A\nTitle: ta\n\nba\nA>>>');
    expect(p).toContain('[... diff truncated: 10 more characters not shown ...]');
    expect(p).toContain('- c1\n');
    expect(p).not.toContain('c1\nbody');
  });

  test('checkJudgment accepts a full judgment and names missing fields', () => {
    const good: Judgment = { A: side(), B: side(), preferred: 'A', preferenceDependsOnMissingEvidence: false, reason: 'r' };
    expect(checkJudgment(good)).toEqual([]);
    const bad = JSON.parse(JSON.stringify(good));
    bad.preferred = 'C';
    delete bad.B.trapsHit;
    bad.A.rubric.scope = 3;
    expect(checkJudgment(bad)).toEqual(['preferred: expected A, B, tie or inconclusive', 'A.rubric.scope: expected 0, 1, 2 or null', 'B.trapsHit: expected strings']);
  });

  test('the schema requires every rubric item', () => {
    expect(JUDGMENT_SCHEMA.properties.A.properties.rubric.required).toEqual(RUBRIC_KEYS);
  });

  test('extractJson tolerates fences and prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a":3} done')).toEqual({ a: 3 });
    expect(() => extractJson('nothing')).toThrow(/no JSON/);
  });

  test('parseJudge knows claude and codex', () => {
    expect(parseJudge('claude').id).toBe('claude:opus');
    expect(parseJudge('claude:sonnet').id).toBe('claude:sonnet');
    expect(parseJudge('codex').id).toBe('codex:default');
    expect(() => parseJudge('gemini')).toThrow(/unknown judge/);
  });
});

describe('pairwise', () => {
  const stored = (labels: { A: string; B: string }, preferred: Judgment['preferred']): StoredJudgment => ({
    rubricVersion: 1,
    promptSha: '',
    judge: 'j',
    case: 'c',
    order: 'ab',
    labels,
    judgment: { A: side(), B: side(), preferred, preferenceDependsOnMissingEvidence: preferred === 'inconclusive', reason: '' },
    at: '',
  });

  test('a win needs both orders to agree', () => {
    const ab = (p: Judgment['preferred']) => stored({ A: 'x', B: 'y' }, p);
    const ba = (p: Judgment['preferred']) => stored({ A: 'y', B: 'x' }, p);
    expect(combine(ab('A'), ba('B'))).toEqual({ verdict: 'x', flipped: false });
    expect(combine(ab('B'), ba('A'))).toEqual({ verdict: 'y', flipped: false });
    expect(combine(ab('A'), ba('A'))).toEqual({ verdict: 'tie', flipped: true }); // always picks first position
    expect(combine(ab('A'), ba('tie'))).toEqual({ verdict: 'tie', flipped: false });
    expect(combine(ab('tie'), ba('tie'))).toEqual({ verdict: 'tie', flipped: false });
  });

  test('judges both orders blind, maps labels back, and caches by prompt', async () => {
    const prompts: string[] = [];
    // Prefers whichever description mentions "blank", wherever it appears.
    const judge: JudgeProvider = {
      id: 'fake:1',
      family: 'test',
      async ask(prompt) {
        prompts.push(prompt);
        const a = /<<<A([\s\S]*?)A>>>/.exec(prompt)![1]!;
        const preferred = a.includes('blank') ? 'A' : 'B';
        const j: Judgment = {
          A: side({ claimsCovered: a.includes('blank') ? ['C1', 'C2'] : ['C1'] }),
          B: side({ claimsCovered: a.includes('blank') ? ['C1'] : ['C1', 'C2'] }),
          preferred,
          preferenceDependsOnMissingEvidence: false,
          reason: 'mentions blank names',
        };
        return { text: '```json\n' + JSON.stringify(j) + '\n```', costUsd: 0.01 };
      },
    };
    const loaded = loadCase(EXAMPLE);
    const out = tempDir();
    const x = artifact('tracetoon', 'Falls back to world for missing and blank names.\n\n<sub>Assisted-by: x</sub>');
    const y = artifact('claude-native', 'Falls back to world.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)');
    const r = await judgePair({ loaded, facts, x, y, judge, outDir: out });
    expect(r).toMatchObject({ case: 'example-greet-default', split: 'dev', x: 'tracetoon', y: 'claude-native', verdict: 'tracetoon', flipped: false });
    expect(r.sides.tracetoon!.map((s) => s.claimsCovered)).toEqual([['C1', 'C2'], ['C1', 'C2']]);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p).not.toContain('tracetoon');
      expect(p).not.toContain('Assisted-by');
      expect(p).not.toContain('Generated with');
    }
    const saved = JSON.parse(readFileSync(judgmentPath(out, 'example-greet-default', 'fake:1', 'tracetoon', 'claude-native', 'ba'), 'utf8'));
    expect(saved.labels).toEqual({ A: 'claude-native', B: 'tracetoon' });
    expect(saved.costUsd).toBe(0.01);

    await judgePair({ loaded, facts, x, y, judge, outDir: out });
    expect(prompts).toHaveLength(2); // served from cache
    await judgePair({ loaded, facts, x: { ...x, body: 'Changed: blank names too.' }, y, judge, outDir: out });
    expect(prompts).toHaveLength(4); // the prompt changed, so it is judged again
  });

  test('retries once on an unusable reply, then fails with the reason', async () => {
    let n = 0;
    const judge: JudgeProvider = { id: 'bad', family: 'test', ask: async () => ({ text: n++ ? 'still not json' : '{"preferred":"A"}' }) };
    await expect(
      judgePair({ loaded: loadCase(EXAMPLE), facts, x: artifact('a', 'x'), y: artifact('b', 'y'), judge, outDir: tempDir() }),
    ).rejects.toThrow(/bad gave no usable judgment .*no JSON/);
    expect(n).toBe(2);
  });
});

describe('stats', () => {
  test('sign test', () => {
    expect(signTest(5, 0)).toBeCloseTo(0.0625, 6);
    expect(signTest(3, 3)).toBe(1);
    expect(signTest(8, 1)).toBeCloseTo(0.0390625, 6);
    expect(signTest(0, 0)).toBe(1);
  });

  test('bootstrap interval is reproducible and brackets the mean', () => {
    const xs = [1, 1, 1, 0, -1, 1, 1, 0];
    const ci = bootstrapMeanCI(xs, { seed: 7 });
    expect(bootstrapMeanCI(xs, { seed: 7 })).toEqual(ci);
    expect(ci[0]).toBeLessThanOrEqual(0.5);
    expect(ci[1]).toBeGreaterThanOrEqual(0.5);
    expect(bootstrapMeanCI([1, 1, 1])).toEqual([1, 1]);
  });

  test("Cohen's kappa", () => {
    expect(cohenKappa(['a', 'b', 'a', 'b'], ['a', 'b', 'a', 'b'])).toBe(1);
    expect(cohenKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b'])).toBe(0);
    expect(cohenKappa(['x', 'x', 'y', 'tie', 'x'], ['x', 'y', 'y', 'tie', 'x'])).toBeCloseTo(0.6875, 4);
  });
});

describe('budget', () => {
  test('"none" removes the cap; other values must be dollars', () => {
    expect(parseBudget('none')).toBeUndefined();
    expect(parseBudget('0')).toBeUndefined();
    expect(parseBudget('12.5')).toBe(12.5);
    expect(() => parseBudget('lots')).toThrow(/number of dollars or "none"/);
  });
});

describe('report by model', () => {
  test('breaks head-to-head results down by agent model when cases used more than one', () => {
    const r = (c: string, model: string, verdict: string) => ({
      rubricVersion: RUBRIC_VERSION,
      case: c,
      split: 'dev',
      judge: 'claude:opus',
      x: 'tracetoon',
      y: 'claude-native',
      model,
      verdict,
      flipped: false,
      sides: { tracetoon: [side()], 'claude-native': [side()] },
      warnings: [],
    });
    const report = buildReport({
      results: [r('a', 'opus', 'tracetoon'), r('b', 'opus', 'tracetoon'), r('c', 'sonnet', 'claude-native')],
      artifacts: new Map(),
      facts: new Map([['a', facts], ['b', facts], ['c', facts]]),
      splitOf: new Map([['a', 'dev'], ['b', 'dev'], ['c', 'dev']]),
    });
    expect(report.splits.dev!.byModel.map((p) => [p.model, p.xWins, p.yWins])).toEqual([
      ['opus', 2, 0],
      ['sonnet', 0, 1],
    ]);
    expect(reportMarkdown(report)).toContain('| sonnet | tracetoon vs claude-native | claude:opus | 0 | 1 | 0 | 0 |');
  });

  test('a pair run on different models is flagged', async () => {
    const judge: JudgeProvider = {
      id: 'fake:2',
      family: 'test',
      ask: async () => ({ text: JSON.stringify({ A: side(), B: side(), preferred: 'tie', preferenceDependsOnMissingEvidence: false, reason: '' }) }),
    };
    const x = { ...artifact('tracetoon', 'x'), meta: { ...artifact('tracetoon', 'x').meta, model: 'opus' } };
    const y = { ...artifact('claude-native', 'y'), meta: { ...artifact('claude-native', 'y').meta, model: 'sonnet' } };
    const res = await judgePair({ loaded: loadCase(EXAMPLE), facts, x, y, judge, outDir: tempDir() });
    expect(res.model).toBe('opus');
    expect(res.warnings).toContain('tracetoon ran on opus but claude-native on sonnet');
  });
});

describe('report', () => {
  const pr = (c: string, split: string, judge: string, verdict: string, flipped = false) => ({
    rubricVersion: RUBRIC_VERSION,
    case: c,
    split,
    judge,
    x: 'tracetoon',
    y: 'claude-native',
    verdict,
    flipped,
    sides: { tracetoon: [side({ claimsCovered: ['C1', 'C2'], factualErrors: [] })], 'claude-native': [side({ claimsCovered: ['C1'], factualErrors: ['wrong'] })] },
    warnings: [],
  });

  test('splits stay separate, judges are combined only when they agree', () => {
    const results = [
      pr('a', 'dev', 'claude:opus', 'tracetoon'),
      pr('a', 'dev', 'codex:default', 'tracetoon'),
      pr('b', 'dev', 'claude:opus', 'tracetoon'),
      pr('b', 'dev', 'codex:default', 'claude-native', true),
      pr('t', 'test', 'claude:opus', 'tie'),
      pr('t', 'test', 'codex:default', 'tie'),
    ];
    expect(agreedResults(results).map((r) => r.verdict)).toEqual(['tracetoon', 'tie', 'tie']);
    const arts = new Map([
      ['a', new Map([['tracetoon', artifact('tracetoon', 'one two three')]])],
      ['b', new Map([['tracetoon', artifact('tracetoon', 'one two three four five')]])],
      ['t', new Map()],
    ]);
    const report = buildReport({
      results,
      artifacts: arts as never,
      facts: new Map([['a', facts], ['b', facts], ['t', facts]]),
      splitOf: new Map([['a', 'dev'], ['b', 'dev'], ['t', 'test']]),
    });
    expect(Object.keys(report.splits)).toEqual(['dev', 'test']);
    const dev = report.splits.dev!;
    const claude = dev.pairs.find((p) => p.judge === 'claude:opus')!;
    expect(claude).toMatchObject({ n: 2, xWins: 2, yWins: 0, ties: 0, winRate: 1, signP: 0.5 });
    const agreed = dev.pairs.find((p) => p.judge === 'all judges agree')!;
    expect(agreed).toMatchObject({ xWins: 1, yWins: 0, ties: 1, flips: 1 });
    const tt = dev.systems.find((s) => s.system === 'tracetoon')!;
    expect(tt).toMatchObject({ factualErrors: 0, claimCoverage: 1, medianWords: 5 });
    expect(dev.systems.find((s) => s.system === 'claude-native')).toMatchObject({ factualErrors: 1, claimCoverage: 0.5 });
    expect(report.judgeAgreement).toEqual([{ judges: ['claude:opus', 'codex:default'], items: 3, agreement: 2 / 3, kappa: expect.any(Number) }]);

    expect(dev.byModel).toEqual([]); // one model (none recorded): no breakdown

    const md = reportMarkdown(report);
    expect(md).toContain('## dev split (2 cases)');
    expect(md).toContain('## test split (1 case)');
    expect(md).toContain('| tracetoon vs claude-native | claude:opus | 2 | 0 | 0 | 0 | 0 | 100% | 0.50 |');
    expect(md).toContain('67% of 3 pair verdicts agree');
  });

  test('missing judges cannot turn a single verdict into unanimous agreement, including model breakdowns', () => {
    const results = [
      { ...pr('a', 'dev', 'codex:default', 'claude-native'), model: 'opus' },
      { ...pr('b', 'dev', 'claude:opus', 'tracetoon'), model: 'sonnet' },
      { ...pr('b', 'dev', 'codex:default', 'tracetoon'), model: 'sonnet' },
    ];
    expect(agreedResults(results).map((r) => r.case)).toEqual(['b']);
    const report = buildReport({
      results,
      artifacts: new Map(),
      facts: new Map([['a', facts], ['b', facts]]),
      splitOf: new Map([['a', 'dev'], ['b', 'dev']]),
    });
    expect(report.coverage).toEqual({
      expected: 4,
      completed: 3,
      missing: [{ case: 'a', split: 'dev', x: 'tracetoon', y: 'claude-native', judge: 'claude:opus' }],
    });
    expect(report.splits.dev!.pairs.find((p) => p.judge === 'all judges agree')).toMatchObject({ n: 1, xWins: 1, yWins: 0 });
    expect(report.splits.dev!.byModel.some((p) => p.model === 'opus' && p.judge === 'all judges agree')).toBe(false);
    expect(reportMarkdown(report)).toContain('Completed 3 of 4 expected');
    expect(reportMarkdown(report)).toContain('These results are unavailable, not ties.');
  });

  test('configured judges and artifacts expose failures even when a judge or case has no results', () => {
    const arts = new Map(['a', 'b'].map((c) => [c, new Map([
      ['tracetoon', artifact('tracetoon', 'draft')],
      ['claude-native', artifact('claude-native', 'draft')],
    ])]));
    const report = buildReport({
      results: [pr('a', 'dev', 'codex:default', 'tracetoon')],
      judges: ['claude:opus', 'codex:default'],
      artifacts: arts,
      facts: new Map([['a', facts], ['b', facts]]),
      splitOf: new Map([['a', 'dev'], ['b', 'test']]),
    });
    expect(report.coverage).toMatchObject({ expected: 4, completed: 1 });
    expect(report.coverage.missing).toHaveLength(3);
    expect(report.splits.dev!.pairs.some((p) => p.judge === 'all judges agree')).toBe(false);
    expect(reportMarkdown(report)).toContain('b (test): tracetoon vs claude-native [codex:default]');
  });

  test('the CLI saves judging scope and preserves a wholly missing judge on report rebuild', () => {
    const { root } = copyExample('selected');
    const other = copyExample('other');
    cpSync(other.dir, join(root, 'other'), { recursive: true });
    const out = tempDir();
    const artifacts = join(out, 'artifacts');
    const cli = (...args: string[]) => exec([process.execPath, join(ROOT, 'src', 'cli.ts'), ...args], { cwd: ROOT });
    // No artifacts yet: no provider is called, but the selected scope is recorded.
    expect(cli('judge', '--cases', root, '--case', 'selected', '--systems', 'original,claude-native', '--judges', 'codex', '--out', out, '--artifacts', artifacts).code).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'judging.json'), 'utf8'))).toEqual({
      rubricVersion: RUBRIC_VERSION,
      judges: ['codex:default'], cases: ['selected'], systems: ['original', 'claude-native'],
    });
    for (const c of ['selected', 'other']) {
      mkdirSync(join(artifacts, c), { recursive: true });
      for (const s of ['original', 'claude-native', 'tracetoon']) {
        writeFileSync(join(artifacts, c, `${s}.json`), JSON.stringify({ ...artifact(s, 'draft'), case: c }));
      }
    }
    expect(cli('report', '--cases', root, '--out', out, '--artifacts', artifacts).code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(report.coverage).toEqual({ expected: 1, completed: 0, missing: [
      { case: 'selected', split: 'dev', x: 'original', y: 'claude-native', judge: 'codex:default' },
    ] });
  });
});

describe('session evidence', () => {
  test('lists requests and key commands with their outcomes, then edited files', () => {
    const e = sessionEvidence(loadCase(EXAMPLE));
    expect(e).toContain("USER: greet() prints 'Hello, undefined!'");
    expect(e).toContain('$ bun test\n        -> 2 pass | 0 fail | Ran 2 tests across 1 file.');
    expect(e).toContain('$ git commit -am');
    expect(e).toContain('Files edited in the sessions: /work/greet/greet.js, /work/greet/greet.test.js');
    expect(e).not.toContain('Read'); // file reads are left out
  });

  test('labels earlier user context while excluding earlier commands and edits', () => {
    const { dir } = copyExample('later-base', (c) => (c.repo.baseTime = '2026-01-07T00:00:00Z'));
    const e = sessionEvidence(loadCase(dir));
    expect(e).toContain('EARLIER USER CONTEXT: greet()');
    expect(e).toContain('do not establish a causal request for each later fix');
    expect(e).not.toContain('$ bun test');
    expect(e).not.toContain('Files edited');
  });

  test('reads Codex rollouts', () => {
    const lines = [
      { timestamp: '2026-01-01T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the build' }] } },
      { timestamp: '2026-01-01T10:01:00Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["cargo","test"]}' } },
      { timestamp: '2026-01-01T10:02:00Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'running 3 tests\ntest result: ok. 3 passed; 0 failed' } },
    ].map((l) => JSON.stringify(l)).join('\n');
    const items = sessionItems(lines, 'codex');
    expect(items.map((i) => [i.kind, i.weight])).toEqual([['user', 3], ['command', 2]]);
    expect(items[1]!.result).toContain('3 passed; 0 failed');
  });

  test('retains paired Claude questions, option descriptions and complete answers', () => {
    const lines = [
      { type: 'assistant', timestamp: '2026-01-01T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which routes?', options: [{ label: 'All, test locally', description: 'Build both providers; exercise the local one live.' }] }] } }] } },
      { type: 'user', timestamp: '2026-01-01T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'other', content: 'Unrelated answer' }] } },
      { type: 'user', timestamp: '2026-01-01T10:02:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'Question context '.repeat(40) + 'Answer: All, test locally' }] } },
    ].map(l => JSON.stringify(l)).join('\n');
    const items = sessionItems(lines, 'claude-code');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'decision', weight: 3, at: '2026-01-01T10:02:00Z' });
    expect(items[0]!.text).toContain('Build both providers');
    expect(items[0]!.result).toContain('Answer: All, test locally');
    expect(items[0]!.result).not.toContain('Unrelated answer');
  });

  test('retains correlated Codex question answers without treating arbitrary outputs as decisions', () => {
    const lines = [
      { type: 'function_call', name: 'functions.request_user_input', call_id: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Which route?' }] }) },
      { type: 'function_call_output', call_id: 'other', output: 'Unexpected answer' },
      { type: 'function_call_output', call_id: 'q1', output: { answers: { route: { answers: ['Local'] } } } },
      { type: 'function_call', name: 'request_user_input', call_id: 'bad', arguments: 'not JSON' },
      { type: 'function_call_output', call_id: 'bad', output: 'Not a decision' },
    ].map(payload => JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T10:00:00Z', payload })).join('\n');
    const items = sessionItems(lines, 'codex');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'decision', weight: 3 });
    expect(items[0]!.text).toContain('Which route?');
    expect(items[0]!.result).toContain('Local');
  });

  test('retains typed async user replies, rejects malformed and non-user wrappers, and redacts secrets', () => {
    const secret = 'sk-' + 'a'.repeat(24);
    const reply = '<send_user_message_question_reply>\n' + JSON.stringify([{ question: 'Which route?', answer: `Local ${secret}` }]) + '\n</send_user_message_question_reply>';
    const lines = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<send_user_message_question_reply>[{"question":"Missing answer"}]' }] },
      { type: 'function_call_output', call_id: 'orphan', output: reply },
    ].map(payload => JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T10:00:00Z', payload })).join('\n');
    const items = sessionItems(lines, 'codex');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'decision', weight: 3 });
    expect(items[0]!.text).toContain('Answer: Local [redacted]');
    expect(JSON.stringify(items)).not.toContain(secret);
  });

  test('renders decisions as source evidence rather than shell commands', () => {
    const { dir } = copyExample('decision-evidence', c => { c.sessions = [{ agent: 'claude-code', file: 'decisions.jsonl', cwd: '/work/greet' }]; });
    writeFileSync(join(dir, 'decisions.jsonl'), [
      { type: 'assistant', timestamp: '2026-01-06T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'Which route?' }] } }] } },
      { type: 'user', timestamp: '2026-01-06T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'q', content: 'Selected Local' }] } },
    ].map(l => JSON.stringify(l)).join('\n'));
    const e = sessionEvidence(loadCase(dir));
    expect(e).toContain('[S1] [10:01] RECORDED Q&A:');
    expect(e).toContain('Which route?');
    expect(e).toContain('-> Selected Local');
    expect(e).not.toContain('$ ');
  });

  test('prioritizes current requests over earlier context when the excerpt is full', () => {
    const { dir } = copyExample('context-priority', c => {
      c.repo.baseTime = '2026-01-06T10:00:00Z';
      c.sessions = [{ agent: 'claude-code', file: 'context.jsonl', cwd: '/work/greet' }];
    });
    const previous = 'Previous task ' + 'x'.repeat(120);
    writeFileSync(join(dir, 'context.jsonl'), [
      { type: 'user', timestamp: '2026-01-06T09:30:00Z', message: { content: previous } },
      { type: 'assistant', timestamp: '2026-01-06T09:31:00Z', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'Earlier choice?' }] } }] } },
      { type: 'user', timestamp: '2026-01-06T09:32:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'q', content: 'Selected Local' }] } },
      { type: 'user', timestamp: '2026-01-06T10:01:00Z', message: { content: 'Current scoped request ' + 'y'.repeat(60) } },
    ].map(l => JSON.stringify(l)).join('\n'));
    const loaded = loadCase(dir);
    const full = sessionEvidence(loaded);
    expect(full).toContain('EARLIER USER CONTEXT: ' + previous);
    expect(full).toContain('EARLIER RECORDED Q&A:');
    const bounded = sessionEvidence(loaded, 550);
    expect(bounded).toContain('USER: Current scoped request');
    expect(bounded).not.toContain(previous);
  });

  test('does not label compaction recaps or provider metadata as user requests', () => {
    const content = 'This session is being continued from a previous conversation that ran out of context. Summary: user asked for everything.';
    const lines = [
      { type: 'user', isCompactSummary: true, message: { content: 'A recap with no prefix' } },
      { type: 'user', message: { content } },
      { type: 'user', isMeta: true, message: { content: 'Injected setup' } },
      { type: 'user', message: { content: 'Actual request' } },
    ].map(x => JSON.stringify({ timestamp: '2026-01-01T10:00:00Z', ...x })).join('\n');
    expect(sessionItems(lines, 'claude-code').map(i => i.text)).toEqual(['Actual request']);
    const codex = JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] } });
    expect(sessionItems(codex, 'codex')).toEqual([]);
  });

  test('the prompt carries the evidence and the preparation note', () => {
    const p = buildPrompt({ caseTitle: 'T', facts, commits: [], diff: '', evidence: '[10:00] $ bun test', a: { title: 'a', body: 'a' }, b: { title: 'b', body: 'b' } });
    expect(p).toContain('<<<SESSIONS\n[10:00] $ bun test\nSESSIONS>>>');
    expect(p).toContain(PREPARATION_NOTE);
    expect(p).toContain('Absence never establishes fabrication and never proves a pass.');
  });
});

test('the per-prompt schema allows only the references each side may cite', () => {
  const schema = judgmentSchema({
    A: new Set(['C1', 'C2', 'X1', 'U1', 'T1', 'S1', 'A.V1']),
    B: new Set(['C1', 'X1', 'U1', 'T1', 'S1', 'B.V1', 'B.V10']),
  }) as any;
  const a = schema.properties.A.properties, b = schema.properties.B.properties;
  expect(a.claimsCovered.items.enum).toEqual(['C1', 'C2']);
  expect(a.contextCovered.items.enum).toEqual(['X1']);
  expect(a.uncertaintiesRespected.items.enum).toEqual(['U1']);
  expect(a.trapsHit.items.enum).toEqual(['T1']);
  // A cannot cite B's evidence (the reference a Claude judge invented), and vice versa.
  const aRefs = a.claimAssessments.items.properties.evidenceRefs.items.enum;
  expect(aRefs).toContain('A.V1');
  expect(aRefs).not.toContain('B.V10');
  expect(b.claimAssessments.items.properties.evidenceRefs.items.enum).toContain('B.V10');
  // Everything else keeps the static schema, which stays the default.
  expect(schema.required).toEqual(JUDGMENT_SCHEMA.required);
  expect(judgmentSchema()).toBe(JUDGMENT_SCHEMA);
});

test('judgePair hands the judge the per-prompt reference schema', async () => {
  const schemas: any[] = [];
  const judge: JudgeProvider = {
    id: 'fake:schema',
    family: 'test',
    async ask(_prompt, schema) {
      schemas.push(schema);
      const j: Judgment = { A: side({ claimsCovered: ['C1'] }), B: side({ claimsCovered: ['C1'] }), preferred: 'tie', preferenceDependsOnMissingEvidence: false, reason: 'same' };
      return { text: JSON.stringify(j) };
    },
  };
  await judgePair({ loaded: loadCase(EXAMPLE), facts, x: artifact('tracetoon', 'Falls back to world.'), y: artifact('claude-native', 'Falls back to world too.'), judge, outDir: tempDir() });
  expect(schemas).toHaveLength(2);
  for (const schema of schemas) expect(schema.properties.A.properties.claimsCovered.items.enum).toContain('C1');
});
