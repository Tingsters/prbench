// A PR artifact is everything a reviewer would receive from a system under
// test. Metrics only ever see artifacts, never the tool that made them, so any
// PR-writing tool can be compared with any other.
import { Checker, type Problems } from './check.ts';
import { checkValidation, type ValidationEvidence } from './validation.ts';
import { createHash } from 'node:crypto';

export const ARTIFACT_SCHEMA = 'prbench.artifact/v1';

export interface ArtifactCommit {
  sha?: string;
  message: string;
}

export interface ArtifactMeta {
  /** Name of the tool or flow, e.g. "tracetoon", "claude-code-native", "original". */
  tool: string;
  toolVersion?: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  startedAt: string;
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  experimentId?: string;
  runtimeIdentity?: { version: string; buildId: string; sha256: string };
  stageTimings?: Record<string, number>;
  /** Runtime-reported operational timers, never proof that a validation check passed. */
  toolTimings?: { stage: string; durationMs: number }[];
  toolTimingGaps?: string[];
  writerOutcome?: { exitCode: number; timedOut: boolean; isError: boolean; cleanupTerminated?: boolean };
  /** Anything that went wrong or was skipped while producing the artifact. */
  notes?: string[];
}

export interface PRArtifact {
  schema: typeof ARTIFACT_SCHEMA;
  case: string;
  system: string;
  title: string;
  body: string;
  base: string;
  head?: string;
  commits: ArtifactCommit[];
  /** Unified diff from base to head: the code the PR proposes. */
  diff: string;
  meta: ArtifactMeta;
  /** Optional for v1 compatibility; absence means evidence unavailable, never failure. */
  validation?: ValidationEvidence;
}

/** Binds saved judgments to the exact artifact, including fresh evidence. */
export function artifactDigest(artifact: PRArtifact): string {
  return createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
}

export function checkArtifact(value: unknown): Problems {
  const c = new Checker();
  if (!c.object(value, '')) return c.problems;
  const v = value as Record<string, unknown>;
  if (v.validation !== undefined) c.problems.push(...checkValidation(v.validation));
  if (v.schema !== ARTIFACT_SCHEMA) c.fail('schema', `expected "${ARTIFACT_SCHEMA}"`);
  c.string(v.case, 'case');
  c.string(v.system, 'system');
  c.string(v.title, 'title');
  // A PR body may legitimately be empty; it just has to be present.
  if (typeof v.body !== 'string') c.fail('body', 'expected a string');
  if (typeof v.diff !== 'string') c.fail('diff', 'expected a string');
  c.string(v.base, 'base');
  c.string(v.head, 'head', { optional: true });
  if (c.array(v.commits, 'commits')) {
    (v.commits as unknown[]).forEach((m, i) => {
      if (!c.object(m, `commits[${i}]`)) return;
      const mm = m as Record<string, unknown>;
      c.string(mm.sha, `commits[${i}].sha`, { optional: true });
      c.string(mm.message, `commits[${i}].message`);
    });
  }
  if (c.object(v.meta, 'meta')) {
    const m = v.meta as Record<string, unknown>;
    c.string(m.tool, 'meta.tool');
    c.string(m.toolVersion, 'meta.toolVersion', { optional: true });
    c.string(m.agent, 'meta.agent', { optional: true });
    c.string(m.model, 'meta.model', { optional: true });
    c.string(m.reasoningEffort, 'meta.reasoningEffort', { optional: true });
    if (c.string(m.startedAt, 'meta.startedAt') && Number.isNaN(Date.parse(m.startedAt as string))) {
      c.fail('meta.startedAt', 'expected an ISO timestamp');
    }
    c.number(m.durationMs, 'meta.durationMs', { min: 0 });
    c.number(m.costUsd, 'meta.costUsd', { optional: true, min: 0 });
    c.number(m.inputTokens, 'meta.inputTokens', { optional: true, min: 0 });
    c.number(m.outputTokens, 'meta.outputTokens', { optional: true, min: 0 });
    c.string(m.experimentId, 'meta.experimentId', { optional: true });
    if (m.runtimeIdentity !== undefined && c.object(m.runtimeIdentity, 'meta.runtimeIdentity')) {
      const runtime = m.runtimeIdentity as Record<string, unknown>;
      for (const k of ['version', 'buildId', 'sha256']) c.string(runtime[k], `meta.runtimeIdentity.${k}`);
    }
    if (m.stageTimings !== undefined && c.object(m.stageTimings, 'meta.stageTimings'))
      for (const [k, v] of Object.entries(m.stageTimings)) c.number(v, `meta.stageTimings.${k}`, { min: 0 });
    c.strings(m.toolTimingGaps, 'meta.toolTimingGaps', true);
    if (m.toolTimings !== undefined && c.array(m.toolTimings, 'meta.toolTimings'))
      (m.toolTimings as unknown[]).forEach((timing, i) => {
        const path = `meta.toolTimings[${i}]`;
        if (!c.object(timing, path)) return;
        const t = timing as Record<string, unknown>;
        c.string(t.stage, `${path}.stage`);
        c.number(t.durationMs, `${path}.durationMs`, { min: 0 });
      });
    if (m.writerOutcome !== undefined && c.object(m.writerOutcome, 'meta.writerOutcome')) {
      const outcome = m.writerOutcome as Record<string, unknown>;
      c.number(outcome.exitCode, 'meta.writerOutcome.exitCode');
      for (const k of ['timedOut', 'isError']) if (typeof outcome[k] !== 'boolean') c.fail(`meta.writerOutcome.${k}`, 'expected boolean');
    }
    c.strings(m.notes, 'meta.notes', true);
  }
  return c.problems;
}
