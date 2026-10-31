import { afterAll, describe, expect, test } from 'bun:test';
import { ARTIFACT_SCHEMA, checkArtifact } from '../src/schema/artifact.ts';
import { CaseError, caseDirs, checkCase, checkFacts, FACTS_SCHEMA, loadCase } from '../src/schema/case.ts';
import { CASES, cleanupTemps, copyExample, EXAMPLE, exampleCaseJson } from './helpers.ts';

afterAll(cleanupTemps);

describe('cases', () => {
  test('the example case is valid', () => {
    expect(checkCase(exampleCaseJson(), EXAMPLE)).toEqual([]);
    expect(loadCase(EXAMPLE).case.id).toBe('example-greet-default');
    expect(caseDirs(CASES)).toContain(EXAMPLE);
  });

  const broken: [string, (c: Record<string, any>) => void, RegExp][] = [
    ['replay without head', (c) => delete c.repo.head, /repo\.head: expected a non-empty string/],
    ['replay without sessions', (c) => delete c.sessions, /sessions: replay cases need at least one/],
    ['both bundle and url', (c) => (c.repo.url = 'https://example.invalid/x.git'), /set exactly one of bundle and url/],
    ['neither bundle nor url', (c) => delete c.repo.bundle, /set exactly one of bundle and url/],
    ['base that is not a sha', (c) => (c.repo.base = 'main'), /repo\.base: does not match/],
    ['work branch named main', (c) => (c.repo.branch = 'main'), /repo\.branch: must not be "main"/],
    ['unknown split', (c) => (c.split = 'train'), /split: expected one of dev, test/],
    ['unsupported agent', (c) => (c.sessions[0].agent = 'cursor'), /sessions\[0\]\.agent: expected one of/],
    ['missing session file', (c) => (c.sessions[0].file = 'nope.jsonl'), /sessions\[0\]\.file: file not found/],
    ['bad id', (c) => (c.id = 'Bad Id'), /id: does not match/],
    ['wrong schema', (c) => (c.schema = 'prbench.case/v0'), /schema: expected "prbench\.case\/v1"/],
  ];
  for (const [name, edit, problem] of broken) {
    test(`rejects ${name}`, () => {
      const c = exampleCaseJson();
      edit(c);
      expect(checkCase(c, EXAMPLE).join('\n')).toMatch(problem);
    });
  }

  test('e2e cases need neither head nor sessions', () => {
    const c = exampleCaseJson();
    c.mode = 'e2e';
    delete c.repo.head;
    delete c.sessions;
    delete c.original;
    expect(checkCase(c, EXAMPLE)).toEqual([]);
  });

  test('loadCase lists every problem and checks the id matches the directory', () => {
    const { dir } = copyExample('renamed', (c) => (c.id = 'other-name'));
    expect(() => loadCase(dir)).toThrow(/must match the directory name "renamed"/);
    const { dir: bad } = copyExample('bad', (c) => {
      c.split = 'x';
      delete c.task;
    });
    try {
      loadCase(bad);
      throw new Error('expected loadCase to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CaseError);
      expect((err as CaseError).problems.length).toBe(2);
    }
  });

  test('facts need every list and at least one claim', () => {
    expect(checkFacts({ schema: FACTS_SCHEMA, claims: ['x'], context: [], uncertainties: [], traps: [] })).toEqual([]);
    expect(checkFacts({ schema: FACTS_SCHEMA, claims: [], context: [], uncertainties: [], traps: [] })).toEqual([
      'claims: expected at least one claim',
    ]);
    expect(checkFacts({ schema: FACTS_SCHEMA, claims: ['x'], context: [''], uncertainties: [] }).join('\n')).toMatch(
      /context\[0\]: expected a non-empty string[\s\S]*traps: expected an array/,
    );
  });
});

describe('artifacts', () => {
  const good = () => ({
    schema: ARTIFACT_SCHEMA,
    case: 'c',
    system: 's',
    title: 'T',
    body: '',
    base: 'abc1234',
    commits: [{ message: 'm' }],
    diff: '',
    meta: { tool: 's', startedAt: '2026-01-01T00:00:00Z', durationMs: 0 },
  });

  test('accepts a minimal artifact with an empty body', () => {
    expect(checkArtifact(good())).toEqual([]);
  });

  test('reports each bad field by path', () => {
    const a: Record<string, any> = good();
    a.title = '';
    a.commits = [{ sha: 'x' }];
    a.meta.startedAt = 'yesterday';
    a.meta.durationMs = -1;
    delete a.diff;
    expect(checkArtifact(a)).toEqual([
      'title: expected a non-empty string',
      'diff: expected a string',
      'commits[0].message: expected a non-empty string',
      'meta.startedAt: expected an ISO timestamp',
      'meta.durationMs: expected at least 0',
    ]);
  });
});
