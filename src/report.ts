// Turns pairwise results into report.json and report.md. Dev and test splits
// are always reported separately; there is no blended score.
import { artifactDigest, type PRArtifact } from './schema/artifact.ts';
import type { Facts } from './schema/case.ts';
import { normalizeBody, wordCount } from './judge/normalize.ts';
import type { PairResult } from './judge/pairwise.ts';
import { checkJudgment, RUBRIC_KEYS, RUBRIC_VERSION, type SideJudgment } from './judge/rubric.ts';
import { bootstrapMeanCI, cohenKappa, mean, signTest } from './stats.ts';

export interface PairSummary {
  x: string;
  y: string;
  judge: string; // a judge id, or "all judges agree"
  n: number;
  xWins: number;
  yWins: number;
  ties: number;
  inconclusive: number;
  flips: number;
  /** x wins / (x wins + y wins). */
  winRate: number;
  signP: number;
  /** Mean of +1 (x wins), -1 (y wins), 0 (tie) per case, with a 95% bootstrap interval. */
  meanDiff: number;
  ci: [number, number];
}

export interface SystemSummary {
  system: string;
  judgments: number;
  factualErrors: number;
  unsupportedClaims: number;
  evidenceGaps: number;
  validationEvidence: { artifacts: number; recorded: number; partial: number; unavailable: number };
  claimCoverage: number;
  contextCoverage: number;
  uncertaintiesRespected: number;
  trapsHit: number;
  rubric: Record<string, number>;
  medianWords: number;
  costUsd?: number;
}

export interface Report {
  rubricVersion: number;
  generatedAt: string;
  judges: string[];
  systems: string[];
  coverage: {
    expected: number;
    completed: number;
    missing: { case: string; split: string; x: string; y: string; judge: string }[];
  };
  splits: Record<
    string,
    { cases: string[]; pairs: PairSummary[]; byModel: (PairSummary & { model: string })[]; systems: SystemSummary[] }
  >;
  judgeAgreement: { judges: [string, string]; items: number; agreement: number; kappa: number }[];
  warnings: string[];
}

export const AGREE = 'all judges agree';

function summarizePairs(results: PairResult[], judge: string): PairSummary[] {
  const byPair = new Map<string, PairResult[]>();
  for (const r of results) byPair.set(`${r.x}\u0000${r.y}`, [...(byPair.get(`${r.x}\u0000${r.y}`) ?? []), r]);
  return [...byPair.values()].map((rs) => {
    const { x, y } = rs[0]!;
    const xWins = rs.filter((r) => r.verdict === x).length;
    const yWins = rs.filter((r) => r.verdict === y).length;
    const inconclusive = rs.filter((r) => r.verdict === 'inconclusive').length;
    const diffs = rs.filter((r) => r.verdict !== 'inconclusive').map((r) => (r.verdict === x ? 1 : r.verdict === y ? -1 : 0));
    return {
      x,
      y,
      judge,
      n: rs.length,
      xWins,
      yWins,
      ties: rs.length - xWins - yWins - inconclusive,
      inconclusive,
      flips: rs.filter((r) => r.flipped).length,
      winRate: xWins + yWins ? xWins / (xWins + yWins) : NaN,
      signP: diffs.length ? signTest(xWins, yWins) : NaN,
      meanDiff: mean(diffs),
      ci: bootstrapMeanCI(diffs),
    };
  });
}

/** One result per case and pair: a system's win only when every judge gave it the win. */
export function agreedResults(results: PairResult[], judges = [...new Set(results.map((r) => r.judge))]): PairResult[] {
  const groups = new Map<string, PairResult[]>();
  for (const r of results) {
    const k = `${r.case}\u0000${r.x}\u0000${r.y}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].filter((rs) => judges.every((j) => rs.some((r) => r.judge === j))).map((rs) => {
    const verdicts = new Set(rs.map((r) => r.verdict));
    return {
      ...rs[0]!,
      judge: AGREE,
      verdict: verdicts.has('inconclusive') ? 'inconclusive' : verdicts.size === 1 ? rs[0]!.verdict : 'tie',
      flipped: rs.some((r) => r.flipped),
    };
  });
}

function summarizeSystems(
  results: PairResult[],
  artifacts: Map<string, Map<string, PRArtifact>>,
  facts: Map<string, Facts>,
): SystemSummary[] {
  const sides = new Map<string, { side: SideJudgment; facts: Facts }[]>();
  for (const bySystem of artifacts.values()) for (const system of bySystem.keys()) if (!sides.has(system)) sides.set(system, []);
  for (const r of results) {
    const f = facts.get(r.case)!;
    for (const [system, list] of Object.entries(r.sides)) {
      for (const side of list) sides.set(system, [...(sides.get(system) ?? []), { side, facts: f }]);
    }
  }
  return [...sides.entries()].map(([system, list]) => {
    const frac = (n: number, d: number) => (d ? n / d : NaN);
    const words: number[] = [];
    let cost = 0;
    let costed = false;
    const validationEvidence = { artifacts: 0, recorded: 0, partial: 0, unavailable: 0 };
    for (const [, bySystem] of artifacts) {
      const a = bySystem.get(system);
      if (!a) continue;
      validationEvidence.artifacts++;
      validationEvidence[a.validation?.coverage ?? 'unavailable']++;
      words.push(wordCount(normalizeBody(a.body)));
      if (a.meta.costUsd !== undefined) {
        cost += a.meta.costUsd;
        costed = true;
      }
    }
    words.sort((a, b) => a - b);
    const rubric: Record<string, number> = {};
    for (const k of RUBRIC_KEYS) {
      const xs = list.map((l) => l.side.rubric[k]).filter((v): v is 0 | 1 | 2 => v !== null);
      rubric[k] = mean(xs);
    }
    return {
      system,
      judgments: list.length,
      factualErrors: mean(list.map((l) => l.side.factualErrors.length)),
      unsupportedClaims: mean(list.map((l) => l.side.unsupportedClaims.length)),
      evidenceGaps: mean(list.map((l) => l.side.claimAssessments.filter((a) => a.status === 'unverifiable').length)),
      validationEvidence,
      claimCoverage: mean(list.map((l) => frac(new Set(l.side.claimsCovered).size, l.facts.claims.length))),
      contextCoverage: mean(list.map((l) => frac(new Set(l.side.contextCovered).size, l.facts.context.length)).filter((x) => !Number.isNaN(x))),
      uncertaintiesRespected: mean(
        list.map((l) => frac(new Set(l.side.uncertaintiesRespected).size, l.facts.uncertainties.length)).filter((x) => !Number.isNaN(x)),
      ),
      trapsHit: mean(list.map((l) => l.side.trapsHit.length)),
      rubric,
      medianWords: words.length ? words[Math.floor(words.length / 2)]! : NaN,
      ...(costed ? { costUsd: cost } : {}),
    };
  });
}

export function buildReport(opts: {
  results: PairResult[];
  judges?: string[]; // configured judges, including those with no successful results
  artifacts: Map<string, Map<string, PRArtifact>>; // case -> system -> artifact
  facts: Map<string, Facts>;
  splitOf: Map<string, string>;
}): Report {
  const { results } = opts;
  if (results.some((r) => r.rubricVersion !== RUBRIC_VERSION)) {
    throw new Error(`Cannot combine legacy or mixed rubric results in a v${RUBRIC_VERSION} report. Preserve historical reports; audit evidence and rejudge into a separate output directory.`);
  }
  for (const r of results) if (r.artifactDigests) for (const system of [r.x, r.y]) {
    const artifact = opts.artifacts.get(r.case)?.get(system);
    if (!artifact || r.artifactDigests[system] !== artifactDigest(artifact)) throw new Error(`Artifact/evidence changed or missing for ${r.case}/${system}; rejudge the preserved draft before rebuilding its report.`);
  }
  for (const r of results) for (const list of Object.values(r.sides)) for (const s of list) {
    const problems = checkJudgment({ A: s, B: s, preferred: 'tie', preferenceDependsOnMissingEvidence: false, reason: '' });
    if (problems.length) throw new Error(`Invalid v${RUBRIC_VERSION} side judgment for ${r.case}: ${problems.join('; ')}`);
  }
  const judges = [...new Set(opts.judges ?? results.map((r) => r.judge))].sort();
  const systems = [...new Set([...results.flatMap((r) => [r.x, r.y]), ...[...opts.artifacts.values()].flatMap((a) => [...a.keys()])])].sort();
  const expected = new Map<string, { case: string; split: string; x: string; y: string; judge: string }>();
  const key = (c: string, x: string, y: string, j: string) => JSON.stringify([c, ...[x, y].sort(), j]);
  const addPair = (c: string, split: string, x: string, y: string) => {
    for (const judge of judges) expected.set(key(c, x, y, judge), { case: c, split, x, y, judge });
  };
  for (const [c, arts] of opts.artifacts) {
    const ids = [...arts.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) addPair(c, opts.splitOf.get(c)!, ids[i]!, ids[j]!);
    }
  }
  for (const r of results) addPair(r.case, r.split, r.x, r.y);
  const completed = new Set(results.map((r) => key(r.case, r.x, r.y, r.judge)));
  const missing = [...expected].filter(([k]) => !completed.has(k)).map(([, p]) => p);
  const splits: Report['splits'] = {};
  for (const split of [...new Set(opts.splitOf.values())].sort()) {
    const rs = results.filter((r) => r.split === split);
    const cases = [...new Set([...rs.map((r) => r.case), ...[...opts.artifacts.keys()].filter((c) => opts.splitOf.get(c) === split)])].sort();
    if (!cases.length) continue;
    const arts = new Map([...opts.artifacts].filter(([c]) => cases.includes(c)));
    const pairs = judges.flatMap((j) => summarizePairs(rs.filter((r) => r.judge === j), j));
    if (judges.length > 1) pairs.push(...summarizePairs(agreedResults(rs, judges), AGREE));
    const byModel: (PairSummary & { model: string })[] = [];
    const models = [...new Set(rs.map((r) => r.model).filter((m): m is string => Boolean(m)))].sort();
    if (models.length > 1) {
      for (const model of models) {
        const mr = rs.filter((r) => r.model === model);
        const groups = judges.length > 1 ? [...judges.map((j) => [j, mr.filter((r) => r.judge === j)] as const), [AGREE, agreedResults(mr, judges)] as const] : [[judges[0]!, mr] as const];
        for (const [j, list] of groups) byModel.push(...summarizePairs(list, j).map((p) => ({ ...p, model })));
      }
    }
    splits[split] = { cases, pairs, byModel, systems: summarizeSystems(rs, arts, opts.facts) };
  }

  const judgeAgreement: Report['judgeAgreement'] = [];
  for (let i = 0; i < judges.length; i++) {
    for (let j = i + 1; j < judges.length; j++) {
      const a: string[] = [];
      const b: string[] = [];
      for (const r of results.filter((r) => r.judge === judges[i])) {
        const other = results.find((o) => o.judge === judges[j] && o.case === r.case && o.x === r.x && o.y === r.y);
        if (!other || r.verdict === 'inconclusive' || other.verdict === 'inconclusive') continue;
        a.push(r.verdict);
        b.push(other.verdict);
      }
      judgeAgreement.push({
        judges: [judges[i]!, judges[j]!],
        items: a.length,
        agreement: a.length ? a.filter((v, k) => v === b[k]).length / a.length : NaN,
        kappa: cohenKappa(a, b),
      });
    }
  }
  return {
    rubricVersion: RUBRIC_VERSION,
    generatedAt: new Date().toISOString(),
    judges,
    systems,
    coverage: { expected: expected.size, completed: [...expected.keys()].filter((k) => completed.has(k)).length, missing },
    splits,
    judgeAgreement,
    warnings: [...new Set(results.flatMap((r) => [
      ...r.warnings.map((w) => `${r.case}: ${w}`),
      ...(!r.artifactDigests ? [`${r.case}: imported result has no artifact digests; correspondence to current drafts/evidence is unverified`] : []),
    ]))],
  };
}

const f2 = (x: number) => (Number.isNaN(x) ? '–' : x.toFixed(2));
const pct = (x: number) => (Number.isNaN(x) ? '–' : `${Math.round(x * 100)}%`);

export function reportMarkdown(r: Report): string {
  const out: string[] = ['# prbench report', ''];
  out.push(`Rubric v${r.rubricVersion}. Judges: ${r.judges.join(', ')}. Generated ${r.generatedAt}.`, '');
  out.push('Evidence gaps are unverified claims, not errors or fabrication. Fresh evidence coverage is reported per artifact; partial capture may still establish individual results. Inconclusive preferences are excluded from win/tie statistics, intervals and judge agreement.', '');
  out.push(`Completed ${r.coverage.completed} of ${r.coverage.expected} expected case/pair/judge results (each requires both orders).`, '');
  if (r.coverage.missing.length) {
    out.push('## Missing judgments', '', 'These results are unavailable, not ties. Incomplete pairs are excluded from "all judges agree".', '');
    for (const m of r.coverage.missing) out.push(`- ${m.case} (${m.split}): ${m.x} vs ${m.y} [${m.judge}]`);
    out.push('');
  }
  out.push(
    'Each pair is judged in both orders; a win needs both orders to agree. An evidence-dependent abstention in either order makes the pair inconclusive; other disagreements are ties (a *flip* when the orders picked opposite systems). ' +
      `"${AGREE}" includes only pairs completed by every configured judge, and counts a win only when every judge gave it. With few cases, treat p-values and intervals as a sense of scale, not proof.`,
    '',
  );
  for (const [split, s] of Object.entries(r.splits)) {
    out.push(`## ${split} split (${s.cases.length} case${s.cases.length === 1 ? '' : 's'})`, '', s.cases.join(', '), '');
    out.push('### Head to head', '');
    out.push('| x vs y | judge | x wins | y wins | ties | flips | inconclusive | x win rate | sign test p | mean (x−y) [95% CI] |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const p of s.pairs) {
      out.push(
        `| ${p.x} vs ${p.y} | ${p.judge} | ${p.xWins} | ${p.yWins} | ${p.ties} | ${p.flips} | ${p.inconclusive} | ${pct(p.winRate)} | ${f2(p.signP)} | ${f2(p.meanDiff)} [${f2(p.ci[0])}, ${f2(p.ci[1])}] |`,
      );
    }
    if (s.byModel.length) {
      out.push('', '### Head to head by agent model', '');
      out.push('| model | x vs y | judge | x wins | y wins | ties | flips | inconclusive |');
      out.push('|---|---|---|---|---|---|---|---|---|');
      for (const p of s.byModel) out.push(`| ${p.model} | ${p.x} vs ${p.y} | ${p.judge} | ${p.xWins} | ${p.yWins} | ${p.ties} | ${p.flips} | ${p.inconclusive} |`);
    }
    out.push('', '### Per system (means over every judgment of that system)', '');
    out.push('| system | judgments | factual errors | unsupported overclaims | evidence gaps | claims covered | context covered | uncertainties respected | traps hit | median words | total agent cost |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of s.systems) {
      out.push(
        `| ${x.system} | ${x.judgments} | ${f2(x.factualErrors)} | ${f2(x.unsupportedClaims)} | ${f2(x.evidenceGaps)} | ${pct(x.claimCoverage)} | ${pct(x.contextCoverage)} | ${pct(x.uncertaintiesRespected)} | ${f2(x.trapsHit)} | ${Number.isNaN(x.medianWords) ? '–' : x.medianWords} | ${x.costUsd === undefined ? '–' : `$${x.costUsd.toFixed(2)}`} |`,
      );
    }
    out.push('', '### Fresh writer evidence coverage (artifact counts)', '', '| system | artifacts | recorded | partial | unavailable |', '|---|---|---|---|---|');
    for (const x of s.systems) { const e = x.validationEvidence; out.push(`| ${x.system} | ${e.artifacts} | ${e.recorded} | ${e.partial} | ${e.unavailable} |`); }
    out.push('', '### Rubric (mean of 0–2 scores; n/a items excluded)', '');
    out.push(`| system | ${RUBRIC_KEYS.join(' | ')} |`);
    out.push(`|---|${RUBRIC_KEYS.map(() => '---').join('|')}|`);
    for (const x of s.systems) out.push(`| ${x.system} | ${RUBRIC_KEYS.map((k) => f2(x.rubric[k]!)).join(' | ')} |`);
    out.push('');
  }
  if (r.judgeAgreement.length) {
    out.push('## Judge agreement', '');
    for (const a of r.judgeAgreement) {
      out.push(`- ${a.judges[0]} vs ${a.judges[1]}: ${pct(a.agreement)} of ${a.items} pair verdicts agree; Cohen's kappa ${f2(a.kappa)}.`);
    }
    out.push('');
  }
  if (r.warnings.length) out.push('## Warnings', '', ...r.warnings.map((w) => `- ${w}`), '');
  return out.join('\n');
}
