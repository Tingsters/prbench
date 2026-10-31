// The PR that was actually published for the case: the human (or original
// agent) baseline. It runs no agent; it packages the recorded title and body
// with the case's commits and diff.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_SCHEMA, type PRArtifact } from '../schema/artifact.ts';
import { commitsBetween, diffBetween, resolveRef } from '../run/gitFacts.ts';
import type { System } from './types.ts';

export const original: System = {
  id: 'original',
  description: 'The PR that was actually published for the case (needs case.original and repo.head).',

  supports(loaded) {
    if (!loaded.case.original) return { supported: false, reason: 'case has no original PR' };
    if (!loaded.case.repo.head) return { supported: false, reason: 'case has no head commit' };
    return { supported: true };
  },

  async run({ loaded, sandbox }) {
    const started = Date.now();
    const c = loaded.case;
    const o = c.original!;
    const base = resolveRef(sandbox.repo, c.repo.base);
    const head = resolveRef(sandbox.repo, c.repo.head!);
    const artifact: PRArtifact = {
      schema: ARTIFACT_SCHEMA,
      case: c.id,
      system: 'original',
      title: o.title,
      body: readFileSync(join(loaded.dir, o.body), 'utf8'),
      base,
      head,
      commits: commitsBetween(sandbox.repo, base, head),
      diff: diffBetween(sandbox.repo, base, head),
      meta: {
        tool: 'original',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        ...(o.url ? { notes: [`published at ${o.url}`] } : {}),
      },
    };
    return artifact;
  },
};
