import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare } from '../src/compare.ts';
import { RUBRIC_KEYS } from '../src/judge/rubric.ts';
import { cleanupTemps, copyExample, tempDir } from './helpers.ts';
afterAll(cleanupTemps);

test('frozen comparison runs three systems, both orders, and resumes only matching artifacts', async () => {
  const cases = copyExample('comparison-smoke');
  const skill = tempDir(),
    bin = join(skill, 'bin');
  mkdirSync(bin);
  const name = `tracetoon-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
  const compiled = Bun.spawnSync(
    [
      process.execPath,
      'build',
      '--compile',
      join(import.meta.dir, 'fixtures', 'fake-comparison-runtime.ts'),
      '--outfile',
      join(bin, name),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(compiled.exitCode).toBe(0);
  writeFileSync(join(skill, 'SKILL.md'), '# Synthetic skill');
  writeFileSync(join(skill, 'VERSION'), '0.0.0-test');
  writeFileSync(
    join(skill, 'build.json'),
    JSON.stringify({ version: '0.0.0-test', buildId: 'a'.repeat(64) }),
  );
  const candidate = join(tempDir(), 'skill');
  cpSync(skill, candidate, { recursive: true });
  const auth = tempDir(),
    log = join(tempDir(), 'calls.jsonl');
  writeFileSync(join(auth, 'auth.json'), '{"synthetic":true}');
  const side = {
    factualErrors: [],
    unsupportedClaims: [],
    claimAssessments: [],
    claimsCovered: ['C1'],
    contextCovered: [],
    uncertaintiesRespected: [],
    trapsHit: [],
    rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 2])),
    notes: 'Synthetic equal drafts.',
  };
  const vars = {
    PRBENCH_CODEX_AUTH_HOME: auth,
    PRBENCH_CODEX_COMMAND: JSON.stringify([
      process.execPath,
      join(import.meta.dir, 'fixtures', 'fake-comparison-codex.ts'),
    ]),
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_JUDGMENT: JSON.stringify({
      A: side,
      B: side,
      preferred: 'tie',
      preferenceDependsOnMissingEvidence: false,
      reason: 'Equal synthetic drafts.',
    }),
  };
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, vars);
  const opts = {
    baselineSkill: skill,
    candidateSkill: candidate,
    cases: cases.root,
    split: 'dev',
    out: join(tempDir(), 'experiment'),
  };
  try {
    await compare(opts);
    const summary = JSON.parse(
      readFileSync(join(opts.out, 'summary.json'), 'utf8'),
    );
    expect(summary.writerMetrics.length).toBe(6);
    expect(summary.reports.length).toBe(4);
    expect(
      summary.reports.every(
        (r: any) =>
          r.report.coverage.completed === 2 && r.report.coverage.expected === 2,
      ),
    ).toBe(true);
    expect(summary.qualityGate.passed).toBe(true);
    const isolation = JSON.parse(
      readFileSync(join(opts.out, 'isolation.json'), 'utf8'),
    );
    expect(isolation.probes.length).toBe(6);
    expect(
      isolation.probes.every(
        (p: any) => p.passed && p.catalogue.toolCalls === 0,
      ),
    ).toBe(true);
    expect(
      summary.operations
        .filter((r: any) => r.system !== 'codex-native')
        .every(
          (r: any) =>
            r.toolTimingCases === 1 && r.toolStages.digest.totalMs === 7,
        ),
    ).toBe(true);
    const before = readFileSync(log, 'utf8');
    await compare({ ...opts, resume: true });
    expect(readFileSync(log, 'utf8')).toBe(before);
    const proofPath = join(opts.out, 'isolation.receipt.json');
    const proof = readFileSync(proofPath, 'utf8');
    writeFileSync(
      proofPath,
      JSON.stringify({ experiment: isolation.experiment, digest: 'forged' }),
    );
    await expect(compare({ ...opts, resume: true })).rejects.toThrow(
      'isolation proof',
    );
    writeFileSync(proofPath, proof);
    writeFileSync(join(candidate, 'SKILL.md'), '# Changed input');
    await expect(compare({ ...opts, resume: true })).rejects.toThrow(
      'inputs changed',
    );
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}, 120_000);
