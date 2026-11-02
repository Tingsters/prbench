import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  directoryDigest,
  assertResume,
  prepareCase,
  operationSummary,
} from '../src/compare.ts';
import {
  cleanupExperiment,
  cleanupOwned,
  ownSandbox,
} from '../src/run/cleanup.ts';
import { runCase } from '../src/run/runner.ts';
import { original } from '../src/systems/original.ts';
import { loadCase } from '../src/schema/case.ts';
import { createSandbox } from '../src/run/sandbox.ts';
import { tracetoonDraft, tracetoonTimings } from '../src/systems/tracetoon.ts';
import { cleanupTemps, tempDir, EXAMPLE } from './helpers.ts';
afterAll(cleanupTemps);

test('internal stage timers are retained only for this invocation and invalid records stay explicit', () => {
  const git = tempDir(),
    root = join(git, 'tracetoon', 'runs'),
    start = Date.now();
  for (const [id, owner] of [
    ['20260101-000000', '/work'],
    ['20260101-000001', '/other'],
  ]) {
    const dir = join(root, id!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'task.json'),
      JSON.stringify({
        root: owner,
        branch: 'feature',
        startedAt: new Date(start + 1).toISOString(),
      }),
    );
    writeFileSync(
      join(dir, 'timings.json'),
      JSON.stringify([
        { stage: 'digest', durationMs: 12 },
        { stage: 'context', durationMs: 3 },
        { stage: 'check', durationMs: -1 },
      ]),
    );
  }
  const timing = tracetoonTimings(git, {
    root: '/work',
    branch: 'feature',
    startedAt: start,
  });
  expect(timing.entries).toEqual([
    { stage: 'digest', durationMs: 12 },
    { stage: 'context', durationMs: 3 },
  ]);
  expect(timing.gaps).toContain('An invalid runtime timing was excluded.');
  expect(
    tracetoonTimings(git, { root: '/work', branch: 'other', startedAt: start })
      .entries,
  ).toEqual([]);
  const rows = operationSummary([
    {
      model: 'writer',
      system: 'candidate',
      toolTimings: timing.entries,
      toolTimingGaps: timing.gaps,
    },
  ]);
  expect(rows[0]).toMatchObject({
    toolTimingCases: 1,
    toolTimingGapCases: 1,
    toolStages: { digest: { records: 1, totalMs: 12, medianMs: 12 } },
  });
});

test('operational medians separate queue waits, unknown usage and cleanup warnings', () => {
  const summary = operationSummary([
    {
      model: 'writer',
      system: 'candidate',
      stageTimings: { writerMs: 10, authWaitMs: 1000 },
      inputTokens: 30,
      cleanup: 'pending',
    },
    {
      model: 'writer',
      system: 'candidate',
      stageTimings: { writerMs: 30, authWaitMs: 2000 },
      inputTokens: 10,
    },
  ]);
  expect(summary[0]).toMatchObject({
    writerMedianMs: 20,
    authWaitMedianMs: 1500,
    inputTokenMedian: 20,
    outputTokenMedian: null,
    pendingCleanup: 1,
  });
});

test('resume identity changes with input bytes, including nested skill files', () => {
  const root = tempDir();
  mkdirSync(join(root, 'references'));
  writeFileSync(join(root, 'references', 'guide.md'), 'first');
  const before = directoryDigest(root);
  writeFileSync(join(root, 'references', 'guide.md'), 'second');
  expect(() => assertResume(before, directoryDigest(root))).toThrow(
    'inputs changed',
  );
  expect(() => assertResume(before, before)).not.toThrow();
});

test('a cleanup failure preserves a valid artifact and can be retried by its owner', async () => {
  const out = tempDir(),
    parent = tempDir();
  const result = await runCase(loadCase(EXAMPLE), original, {
    outDir: out,
    sandboxParent: parent,
    dispose: () => {
      throw new Error('EBUSY');
    },
  });
  expect(result.cleanup).toBe('pending');
  expect(JSON.parse(readFileSync(result.path!, 'utf8')).title).toBe(
    result.artifact.title,
  );
  const status = JSON.parse(
    readFileSync(result.path!.replace(/\.json$/, '.status.json'), 'utf8'),
  );
  expect(status.artifact).toBe('saved');
  expect(status.cleanup.error).toBe('EBUSY');
  expect(cleanupExperiment(out)).toEqual({ removed: 1, pending: 0 });
  expect(existsSync(status.cleanup.owner.root)).toBe(false);
  expect(existsSync(result.path!)).toBe(true);
});

test('cleanup refuses a forged token and leaves unrelated directories intact', () => {
  const root = tempDir(),
    owner = ownSandbox(root),
    other = tempDir();
  writeFileSync(join(other, 'keep'), 'unrelated');
  expect(() => cleanupOwned({ ...owner, token: 'wrong' })).toThrow('ownership');
  expect(() => cleanupOwned({ ...owner, root: other })).toThrow();
  expect(existsSync(join(other, 'keep'))).toBe(true);
});

test('preparation failure prevents writer execution and preserves its primary error', async () => {
  let called = false;
  const fake = {
    ...original,
    id: 'spy',
    run: async () => {
      called = true;
      throw new Error('writer ran');
    },
  };
  await expect(
    runCase(loadCase(EXAMPLE), fake, {
      prepare: () => {
        throw new Error('fixture unavailable');
      },
      dispose: () => {
        throw new Error('EBUSY');
      },
    }),
  ).rejects.toThrow('fixture unavailable');
  expect(called).toBe(false);
});

test('preparation commands that alter tracked case content are rejected', () => {
  const sandbox = createSandbox(loadCase(EXAMPLE), { parent: tempDir() });
  try {
    expect(() =>
      prepareCase(sandbox, 'example-greet-default', {
        cases: {
          'example-greet-default': {
            commands: [
              [
                process.execPath,
                '-e',
                'require("fs").writeFileSync("greet.js", "changed")',
              ],
            ],
          },
        },
      }),
    ).toThrow('tracked case content');
  } finally {
    sandbox.dispose();
  }
});

test('draft fallback is restricted to this invocation and ambiguity never chooses a draft', () => {
  const git = tempDir(),
    runs = join(git, 'tracetoon', 'runs'),
    startedAt = Date.now();
  const make = (id: string, root: string) => {
    const run = join(runs, id);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'title.txt'), 'Draft');
    writeFileSync(join(run, 'body.md'), 'Body');
    writeFileSync(
      join(run, 'task.json'),
      JSON.stringify({
        root,
        branch: 'feature',
        startedAt: new Date(startedAt + 1).toISOString(),
      }),
    );
  };
  make('20260101-000000', '/other');
  make('20260101-000001', '/work');
  writeFileSync(join(runs, 'latest'), 'empty');
  const invocation = { root: '/work', branch: 'feature', startedAt };
  expect(tracetoonDraft(git, invocation)?.run).toBe('20260101-000001');
  make('20260101-000002', '/work');
  expect(() => tracetoonDraft(git, invocation)).toThrow('More than one draft');
});
