// Pairwise judging: every pair of systems on a case, by every judge, in both
// orders. A pair's verdict is a win only when both orders pick the same
// system; anything else is a tie, and a disagreement is recorded as a flip.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactDigest, type PRArtifact } from '../schema/artifact.ts';
import type { Facts, LoadedCase } from '../schema/case.ts';
import { sessionEvidence } from './evidence.ts';
import { normalizeBody, normalizeTitle } from './normalize.ts';
import { extractJson, type JudgeProvider } from './providers.ts';
import { buildPrompt, checkJudgment, RUBRIC_VERSION, type Judgment, type SideJudgment } from './rubric.ts';
import { validationPacket } from './validation.ts';

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
  rubricVersion: number;
  /** Always set by judgePair. Optional for external/synthetic result importers. */
  artifactDigests?: Record<string, string>;
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
    a: { title: normalizeTitle(a.title), body: normalizeBody(a.body), validation: a.validation, ...(a.diff !== b.diff ? { diff: a.diff } : {}) },
    b: { title: normalizeTitle(b.title), body: normalizeBody(b.body), validation: b.validation, ...(a.diff !== b.diff ? { diff: b.diff } : {}) },
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
  return join(outDir, `v${RUBRIC_VERSION}`, caseId, safe(judge), `${x}__${y}__${order}.json`);
}

/** Maps an order's preference back to a system id, or "tie". */
export function preferredSystem(stored: StoredJudgment): string {
  const p = stored.judgment.preferred;
  return p === 'tie' || p === 'inconclusive' ? p : stored.labels[p];
}

/** Combines the two orders: a win needs both orders to agree. */
export function combine(ab: StoredJudgment, ba: StoredJudgment): { verdict: string; flipped: boolean } {
  const p1 = preferredSystem(ab);
  const p2 = preferredSystem(ba);
  if (p1 === 'inconclusive' || p2 === 'inconclusive') return { verdict: 'inconclusive', flipped: false };
  if (p1 === p2) return { verdict: p1, flipped: false };
  return { verdict: 'tie', flipped: p1 !== 'tie' && p2 !== 'tie' };
}

async function judgeOnce(
  judge: JudgeProvider,
  prompt: string,
  meta: Omit<StoredJudgment, 'judgment' | 'promptSha' | 'rubricVersion' | 'at' | 'judge' | 'costUsd'>,
  path: string,
  force: boolean,
  refs: { A: Set<string>; B: Set<string> },
): Promise<StoredJudgment> {
  const promptSha = sha(prompt);
  if (!force && existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as StoredJudgment;
    if (cached.rubricVersion === RUBRIC_VERSION && cached.promptSha === promptSha && !checkJudgment(cached.judgment, refs).length) return cached;
  }
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let reply;
    try { reply = await judge.ask(prompt); }
    catch (error) { lastError = String(error); continue; }
    let parsed: unknown;
    try {
      parsed = extractJson(reply.text);
    } catch (err) {
      lastError = String(err);
      continue;
    }
    const problems = checkJudgment(parsed, refs);
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
  for (const a of [x, y]) if (!a.validation || a.validation.coverage !== 'recorded') warnings.push(`${a.system}: fresh validation evidence ${a.validation?.coverage ?? 'unavailable (legacy artifact)'}`);
  if (x.diff !== y.diff) warnings.push(`${x.system} and ${y.system} propose different diffs; each description receives its own proposed diff`);
  const run = (order: Order) => {
    const [a, b] = order === 'ab' ? [x, y] : [y, x];
    const original = evidenceFor(loaded);
    const shared = ['D', ...x.commits.map((_, i) => `K${i + 1}`),
      ...facts.claims.map((_, i) => `C${i + 1}`), ...facts.context.map((_, i) => `X${i + 1}`),
      ...facts.uncertainties.map((_, i) => `U${i + 1}`), ...facts.traps.map((_, i) => `T${i + 1}`),
      ...[...original.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]!)];
    const references = (artifact: PRArtifact, label: 'A' | 'B') => new Set([...shared,
      ...validationPacket(artifact.validation, label).refs, ...(a.diff !== b.diff ? [`${label}.D`] : [])]);
    return judgeOnce(
      judge,
      promptFor(c.title, facts, x, a, b, original),
      { case: c.id, order, labels: { A: a.system, B: b.system } },
      judgmentPath(outDir, c.id, judge.id, x.system, y.system, order),
      opts.force ?? false,
      { A: references(a, 'A'), B: references(b, 'B') },
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
    rubricVersion: RUBRIC_VERSION,
    artifactDigests: { [x.system]: artifactDigest(x), [y.system]: artifactDigest(y) },
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
