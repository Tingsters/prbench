// A PR artifact is everything a reviewer would receive from a system under
// test. Metrics only ever see artifacts, never the tool that made them, so any
// PR-writing tool can be compared with any other.
import { Checker, type Problems } from './check.ts';

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
  startedAt: string;
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
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
  /** Unified diff from base to head. Empty when the system didn't produce or change code (e.g. "original"). */
  diff: string;
  meta: ArtifactMeta;
}

export function checkArtifact(value: unknown): Problems {
  const c = new Checker();
  if (!c.object(value, '')) return c.problems;
  const v = value as Record<string, unknown>;
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
    if (c.string(m.startedAt, 'meta.startedAt') && Number.isNaN(Date.parse(m.startedAt as string))) {
      c.fail('meta.startedAt', 'expected an ISO timestamp');
    }
    c.number(m.durationMs, 'meta.durationMs', { min: 0 });
    c.number(m.costUsd, 'meta.costUsd', { optional: true, min: 0 });
    c.number(m.inputTokens, 'meta.inputTokens', { optional: true, min: 0 });
    c.number(m.outputTokens, 'meta.outputTokens', { optional: true, min: 0 });
    c.strings(m.notes, 'meta.notes', true);
  }
  return c.problems;
}
