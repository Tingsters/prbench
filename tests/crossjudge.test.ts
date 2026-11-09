import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossJudge, JUDGE_ENTRIES, type CrossSummary } from '../src/crossjudge.ts';
import { judgmentPath } from '../src/judge/pairwise.ts';
import type { JudgeProvider } from '../src/judge/providers.ts';
import { RUBRIC_KEYS, RUBRIC_VERSION, type Judgment, type SideJudgment } from '../src/judge/rubric.ts';
import { implementationDigest } from '../src/run/cache.ts';
import { ARTIFACT_SCHEMA, artifactDigest, checkArtifact, type PRArtifact } from '../src/schema/artifact.ts';
import { cleanupTemps, EXAMPLE, ROOT, tempDir } from './helpers.ts';

afterAll(cleanupTemps);

const JUDGES = ['fake:one', 'fake:two'];
const CASES = ['case-a', 'case-b'];
const CONTRACT = implementationDigest(ROOT, JUDGE_ENTRIES);

/** Body by replicate/case: STRONG marks the draft the fake judges prefer. */
const bodies: Record<string, { candidate: string; baseline: string }> = {
  '1/case-a': { candidate: 'STRONG description', baseline: 'plain description' },
  '2/case-a': { candidate: 'STRONG description', baseline: 'plain description' },
  '1/case-b': { candidate: 'plain description', baseline: 'STRONG description' },
  '2/case-b': { candidate: 'plain description', baseline: 'other plain description' },
};

function draft(caseId: string, system: string, model: string, body: string): PRArtifact {
  return {
    schema: ARTIFACT_SCHEMA, case: caseId, system, title: 'Greet world', body, base: 'a'.repeat(40), head: 'b'.repeat(40),
    commits: [], diff: '+fallback', meta: { tool: system, model, startedAt: '2026-01-01T00:00:00Z', durationMs: 60_000 },
  } as PRArtifact;
}

/** A tiny finished compare run with one writer model. */
function fixtureRun(name: string, model: string, system: string, edit: (m: any) => void = () => {}) {
  const root = join(tempDir('prbench-cross-'), name);
  const id = `exp-${name}`;
  for (const c of CASES) {
    const dir = join(root, 'inputs', 'cases', c);
    cpSync(EXAMPLE, dir, { recursive: true });
    const json = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
    json.id = c;
    writeFileSync(join(dir, 'case.json'), JSON.stringify(json));
  }
  const manifest: any = {
    schema: 'prbench.comparison/v2', id, identity: id, split: 'dev', judgeContract: CONTRACT,
    cases: CASES.map((c) => ({ id: c, hash: `hash-${c}`, writerIdentity: 'w' })),
    settings: { provider: 'claude', models: [model], systems: ['tracetoon-baseline', 'tracetoon-candidate'], judges: JUDGES, effort: 'medium', replicates: 2, rubricVersion: RUBRIC_VERSION },
  };
  edit(manifest);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  for (let r = 1; r <= 2; r++)
    for (const c of CASES) {
      const base = r === 1 ? join(root, model) : join(root, `replicate-00${r}`, model);
      const dir = join(base, 'artifacts', c);
      mkdirSync(dir, { recursive: true });
      const which = system === 'tracetoon-candidate' ? 'candidate' : 'baseline';
      const a = draft(c, system, model, `${bodies[`${r}/${c}`]![which]} (replicate ${r})`);
      expect(checkArtifact(a)).toEqual([]);
      writeFileSync(join(dir, `${system}.json`), JSON.stringify(a));
      writeFileSync(join(dir, `${system}.receipt.json`), JSON.stringify({ experiment: id, key: 'k', digest: artifactDigest(a) }));
    }
  return root;
}

const side = (strong: boolean): SideJudgment => ({
  claimAssessments: strong ? [] : [{ claim: 'A wrong claim', status: 'contradicted', evidenceRefs: ['D'], reason: 'diff disagrees' }],
  factualErrors: strong ? [] : ['A wrong claim'], unsupportedClaims: [],
  claimsCovered: strong ? ['C1', 'C2', 'C3', 'C4'] : ['C1'], contextCovered: [], uncertaintiesRespected: [], trapsHit: [],
  rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, strong ? 2 : 1])) as SideJudgment['rubric'], notes: '',
});

function fakeJudges(prompts: string[]) {
  return (spec: string): JudgeProvider => ({
    id: spec, family: 'test',
    ask: async (prompt) => {
      prompts.push(prompt);
      const a = /^<<<A\n([\s\S]*?)^A>>>/m.exec(prompt)![1]!.includes('STRONG');
      const b = /^<<<B\n([\s\S]*?)^B>>>/m.exec(prompt)![1]!.includes('STRONG');
      const j: Judgment = { A: side(a), B: side(b), preferred: a ? 'A' : b ? 'B' : 'tie', preferenceDependsOnMissingEvidence: false, reason: 'fixture' };
      return { text: JSON.stringify(j), costUsd: 0.5 };
    },
  });
}

describe('crossjudge', () => {
  test('pairs candidate drafts of one run with baseline drafts of another and summarises consensus', async () => {
    const candidate = fixtureRun('haiku', 'claude-haiku@low', 'tracetoon-candidate');
    const baseline = fixtureRun('sonnet', 'claude-sonnet@medium', 'tracetoon-baseline');
    const out = join(tempDir(), 'cross');
    const prompts: string[] = [];
    const log = () => {};
    const plan = await crossJudge({ candidate, baseline, out, plan: true, judgeFor: fakeJudges(prompts), log });
    expect(plan).toEqual({ plan: { calls: 16, pairs: 8 } });
    expect(prompts).toHaveLength(0);
    expect(existsSync(out)).toBe(false);

    const s = (await crossJudge({ candidate, baseline, out, parallel: 3, judgeFor: fakeJudges(prompts), log })) as CrossSummary;
    expect(prompts).toHaveLength(16);
    expect(s.newJudgeCalls).toBe(16);
    expect(s.consensus).toMatchObject({ wins: 2, ties: 1, losses: 1, inconclusive: 0 });
    for (const j of JUDGES) expect(s.byJudge[j]).toMatchObject({ wins: 2, ties: 1, losses: 1 });
    expect(s.byCase['case-a']!.consensus).toMatchObject({ wins: 2, losses: 0 });
    expect(s.byCase['case-b']!.consensus).toMatchObject({ wins: 0, ties: 1, losses: 1 });
    expect(s.byCase['case-a']!.candidate.composite).toBe(70); // full claims and rubric; no context or uncertainty
    expect(s.byCase['case-a']!.baseline.composite).toBe(11.25); // 35/4 + 35/2 - 15 for one factual error
    expect(s.byCase['case-a']!.baseline.factualErrors).toBe(1);
    expect(s.sides.candidate.drafts).toBe(4);
    expect(s.sides.candidate.judgments).toBe(16);
    expect(s.judgeCostUsd).toBe(8);
    expect(s.candidate).toMatchObject({ model: 'claude-haiku@low', system: 'tracetoon-candidate', experiment: 'exp-haiku' });
    expect(s.baseline).toMatchObject({ model: 'claude-sonnet@medium', system: 'tracetoon-baseline', experiment: 'exp-sonnet' });
    // Baseline is x, candidate is y, as in compare; judgments are per replicate.
    const file = judgmentPath(join(out, 'replicate-002', 'judgments'), 'case-b', 'fake:one', 'tracetoon-baseline', 'tracetoon-candidate', 'ba');
    expect(JSON.parse(readFileSync(file, 'utf8')).labels).toEqual({ A: 'tracetoon-candidate', B: 'tracetoon-baseline' });
    expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('Consensus W/T/L: 2/1/1');
    expect(JSON.parse(readFileSync(join(out, 'pairs.json'), 'utf8'))).toHaveLength(8);

    // A rerun reuses every saved judgment.
    const again = (await crossJudge({ candidate, baseline, out, judgeFor: fakeJudges(prompts), log })) as CrossSummary;
    expect(prompts).toHaveLength(16);
    expect(again.consensus).toEqual(s.consensus);
  });

  test('refuses runs whose judge contract, judges, cases or replicates differ', async () => {
    const baseline = fixtureRun('sonnet', 'claude-sonnet@medium', 'tracetoon-baseline');
    const judgeFor = fakeJudges([]);
    const run = (edit: (m: any) => void) =>
      crossJudge({ candidate: fixtureRun('haiku', 'claude-haiku@low', 'tracetoon-candidate', edit), baseline, out: join(tempDir(), 'x'), judgeFor, log: () => {} });
    await expect(run((m) => (m.judgeContract = 'f'.repeat(64)))).rejects.toThrow(/judgeContract: candidate "f+"/);
    await expect(run((m) => (m.settings.judges = ['fake:one']))).rejects.toThrow('judges:');
    await expect(run((m) => (m.cases[1].hash = 'changed'))).rejects.toThrow('cases:');
    await expect(run((m) => (m.settings.replicates = 3))).rejects.toThrow('replicates:');
  });

  test('refuses a missing draft before any judge call', async () => {
    const candidate = fixtureRun('haiku', 'claude-haiku@low', 'tracetoon-candidate');
    const baseline = fixtureRun('sonnet', 'claude-sonnet@medium', 'tracetoon-baseline');
    rmSync(join(candidate, 'replicate-002', 'claude-haiku@low', 'artifacts', 'case-b', 'tracetoon-candidate.json'));
    const prompts: string[] = [];
    await expect(crossJudge({ candidate, baseline, out: join(tempDir(), 'x'), judgeFor: fakeJudges(prompts), log: () => {} })).rejects.toThrow('Missing draft');
    expect(prompts).toHaveLength(0);
  });
});
