import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_SCHEMA, type PRArtifact } from '../src/schema/artifact.ts';
import { FACTS_SCHEMA, loadCase, type Facts } from '../src/schema/case.ts';
import { normalizeBody, wordCount } from '../src/judge/normalize.ts';
import { combine, judgePair, judgmentPath, type StoredJudgment } from '../src/judge/pairwise.ts';
import { extractJson, parseJudge, type JudgeProvider } from '../src/judge/providers.ts';
import { buildPrompt, checkJudgment, JUDGMENT_SCHEMA, RUBRIC_KEYS, type Judgment, type SideJudgment } from '../src/judge/rubric.ts';
import { agreedResults, buildReport, reportMarkdown } from '../src/report.ts';
import { bootstrapMeanCI, cohenKappa, signTest } from '../src/stats.ts';
import { parseBudget } from '../src/systems/agentShared.ts';
import { EXAMPLE, tempDir } from './helpers.ts';

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
    const good: Judgment = { A: side(), B: side(), preferred: 'A', reason: 'r' };
    expect(checkJudgment(good)).toEqual([]);
    const bad = JSON.parse(JSON.stringify(good));
    bad.preferred = 'C';
    delete bad.B.trapsHit;
    bad.A.rubric.scope = 3;
    expect(checkJudgment(bad)).toEqual(['preferred: expected A, B or tie', 'A.rubric.scope: expected 0, 1, 2 or null', 'B.trapsHit: expected strings']);
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
    judgment: { A: side(), B: side(), preferred, reason: '' },
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
      ask: async () => ({ text: JSON.stringify({ A: side(), B: side(), preferred: 'tie', reason: '' }) }),
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
    expect(md).toContain('| tracetoon vs claude-native | claude:opus | 2 | 0 | 0 | 0 | 100% | 0.50 |');
    expect(md).toContain('67% of 3 pair verdicts agree');
  });
});
