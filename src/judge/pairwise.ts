// Pairwise judging: every pair of systems on a case, by every judge, in both
// orders. A pair's verdict is a win only when both orders pick the same
// system; anything else is a tie, and a disagreement is recorded as a flip.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PRArtifact } from '../schema/artifact.ts';
import type { Facts, LoadedCase } from '../schema/case.ts';
import { sessionEvidence } from './evidence.ts';
import { normalizeBody, normalizeTitle } from './normalize.ts';
import { extractJson, type JudgeProvider } from './providers.ts';
import { buildPrompt, checkJudgment, RUBRIC_VERSION, type Judgment, type SideJudgment } from './rubric.ts';

export type Order = 'ab' | 'ba';

export interface StoredJudgment {
  rubricVersion: number;
  promptSha: string;
  judge: string;
  case: string;
  order: Order;
  /** Which system each label stood for. */
  labels: { A: string; B: string };
  judgment: Judgment;
  costUsd?: number;
  at: string;
}

export interface PairResult {
  case: string;
  split: string;
  judge: string;
  x: string;
  y: string;
  /** The model the agent systems in this pair ran on, when any did. */
  model?: string;
  /** The winning system, or "tie". */
  verdict: string;
  /** The two orders picked different systems. */
  flipped: boolean;
  /** Per-system side judgments from both orders. */
  sides: Record<string, SideJudgment[]>;
  warnings: string[];
}

export function promptFor(
  caseTitle: string,
  facts: Facts,
  first: PRArtifact,
  a: PRArtifact,
  b: PRArtifact,
  evidence?: string,
): string {
  return buildPrompt({
    caseTitle,
    facts,
    commits: first.commits.map((c) => c.message),
    diff: first.diff,
    evidence,
    a: { title: normalizeTitle(a.title), body: normalizeBody(a.body) },
    b: { title: normalizeTitle(b.title), body: normalizeBody(b.body) },
  });
}

const evidenceCache = new Map<string, string>();
function evidenceFor(loaded: LoadedCase): string {
  let e = evidenceCache.get(loaded.dir);
  if (e === undefined) {
    e = sessionEvidence(loaded);
    evidenceCache.set(loaded.dir, e);
  }
  return e;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

export function judgmentPath(outDir: string, caseId: string, judge: string, x: string, y: string, order: Order): string {
  return join(outDir, caseId, safe(judge), `${x}__${y}__${order}.json`);
}

/** Maps an order's preference back to a system id, or "tie". */
export function preferredSystem(stored: StoredJudgment): string {
  const p = stored.judgment.preferred;
  return p === 'tie' ? 'tie' : stored.labels[p];
}

/** Combines the two orders: a win needs both orders to agree. */
export function combine(ab: StoredJudgment, ba: StoredJudgment): { verdict: string; flipped: boolean } {
  const p1 = preferredSystem(ab);
  const p2 = preferredSystem(ba);
  if (p1 === p2) return { verdict: p1, flipped: false };
  return { verdict: 'tie', flipped: p1 !== 'tie' && p2 !== 'tie' };
}

async function judgeOnce(
  judge: JudgeProvider,
  prompt: string,
  meta: Omit<StoredJudgment, 'judgment' | 'promptSha' | 'rubricVersion' | 'at' | 'judge' | 'costUsd'>,
  path: string,
  force: boolean,
): Promise<StoredJudgment> {
  const promptSha = sha(prompt);
  if (!force && existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as StoredJudgment;
    if (cached.promptSha === promptSha) return cached;
  }
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await judge.ask(prompt);
    let parsed: unknown;
    try {
      parsed = extractJson(reply.text);
    } catch (err) {
      lastError = String(err);
      continue;
    }
    const problems = checkJudgment(parsed);
    if (problems.length) {
      lastError = problems.join('; ');
      continue;
    }
    const stored: StoredJudgment = {
      rubricVersion: RUBRIC_VERSION,
      promptSha,
      judge: judge.id,
      ...meta,
      judgment: parsed as Judgment,
      ...(reply.costUsd !== undefined ? { costUsd: reply.costUsd } : {}),
      at: new Date().toISOString(),
    };
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(stored, null, 2) + '\n');
    return stored;
  }
  throw new Error(`${judge.id} gave no usable judgment for ${meta.case} (${meta.labels.A} vs ${meta.labels.B}): ${lastError}`);
}

export async function judgePair(opts: {
  loaded: LoadedCase;
  facts: Facts;
  x: PRArtifact;
  y: PRArtifact;
  judge: JudgeProvider;
  outDir: string;
  force?: boolean;
}): Promise<PairResult> {
  const { loaded, facts, x, y, judge, outDir } = opts;
  const c = loaded.case;
  const warnings: string[] = [];
  if (x.diff !== y.diff) warnings.push(`${x.system} and ${y.system} propose different diffs; judged against ${x.system}'s`);
  const run = (order: Order) => {
    const [a, b] = order === 'ab' ? [x, y] : [y, x];
    return judgeOnce(
      judge,
      promptFor(c.title, facts, x, a, b, evidenceFor(loaded)),
      { case: c.id, order, labels: { A: a.system, B: b.system } },
      judgmentPath(outDir, c.id, judge.id, x.system, y.system, order),
      opts.force ?? false,
    );
  };
  const ab = await run('ab');
  const ba = await run('ba');
  const sides: Record<string, SideJudgment[]> = { [x.system]: [], [y.system]: [] };
  for (const s of [ab, ba]) {
    sides[s.labels.A]!.push(s.judgment.A);
    sides[s.labels.B]!.push(s.judgment.B);
  }
  if (x.meta.model && y.meta.model && x.meta.model !== y.meta.model) {
    warnings.push(`${x.system} ran on ${x.meta.model} but ${y.system} on ${y.meta.model}`);
  }
  const model = x.meta.model ?? y.meta.model;
  return {
    case: c.id,
    split: c.split,
    judge: judge.id,
    x: x.system,
    y: y.system,
    ...(model ? { model } : {}),
    ...combine(ab, ba),
    sides,
    warnings,
  };
}
