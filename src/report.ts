// Turns pairwise results into report.json and report.md. Dev and test splits
// are always reported separately; there is no blended score.
import type { PRArtifact } from './schema/artifact.ts';
import type { Facts } from './schema/case.ts';
import { normalizeBody, wordCount } from './judge/normalize.ts';
import type { PairResult } from './judge/pairwise.ts';
import { RUBRIC_KEYS, RUBRIC_VERSION, type SideJudgment } from './judge/rubric.ts';
import { bootstrapMeanCI, cohenKappa, mean, signTest } from './stats.ts';

export interface PairSummary {
  x: string;
  y: string;
  judge: string; // a judge id, or "all judges agree"
  n: number;
  xWins: number;
  yWins: number;
  ties: number;
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
  splits: Record<string, { cases: string[]; pairs: PairSummary[]; systems: SystemSummary[] }>;
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
    const diffs = rs.map((r) => (r.verdict === x ? 1 : r.verdict === y ? -1 : 0));
    return {
      x,
      y,
      judge,
      n: rs.length,
      xWins,
      yWins,
      ties: rs.length - xWins - yWins,
      flips: rs.filter((r) => r.flipped).length,
      winRate: xWins + yWins ? xWins / (xWins + yWins) : NaN,
      signP: signTest(xWins, yWins),
      meanDiff: mean(diffs),
      ci: bootstrapMeanCI(diffs),
    };
  });
}

/** One result per case and pair: a system's win only when every judge gave it the win. */
export function agreedResults(results: PairResult[]): PairResult[] {
  const groups = new Map<string, PairResult[]>();
  for (const r of results) {
    const k = `${r.case}\u0000${r.x}\u0000${r.y}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    const verdicts = new Set(rs.map((r) => r.verdict));
    return {
      ...rs[0]!,
      judge: AGREE,
      verdict: verdicts.size === 1 ? rs[0]!.verdict : 'tie',
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
    for (const [, bySystem] of artifacts) {
      const a = bySystem.get(system);
      if (!a) continue;
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
  artifacts: Map<string, Map<string, PRArtifact>>; // case -> system -> artifact
  facts: Map<string, Facts>;
  splitOf: Map<string, string>;
}): Report {
  const { results } = opts;
  const judges = [...new Set(results.map((r) => r.judge))].sort();
  const systems = [...new Set(results.flatMap((r) => [r.x, r.y]))].sort();
  const splits: Report['splits'] = {};
  for (const split of [...new Set(opts.splitOf.values())].sort()) {
    const rs = results.filter((r) => r.split === split);
    if (rs.length === 0) continue;
    const cases = [...new Set(rs.map((r) => r.case))].sort();
    const arts = new Map([...opts.artifacts].filter(([c]) => cases.includes(c)));
    const pairs = judges.flatMap((j) => summarizePairs(rs.filter((r) => r.judge === j), j));
    if (judges.length > 1) pairs.push(...summarizePairs(agreedResults(rs), AGREE));
    splits[split] = { cases, pairs, systems: summarizeSystems(rs, arts, opts.facts) };
  }

  const judgeAgreement: Report['judgeAgreement'] = [];
  for (let i = 0; i < judges.length; i++) {
    for (let j = i + 1; j < judges.length; j++) {
      const a: string[] = [];
      const b: string[] = [];
      for (const r of results.filter((r) => r.judge === judges[i])) {
        const other = results.find((o) => o.judge === judges[j] && o.case === r.case && o.x === r.x && o.y === r.y);
        if (!other) continue;
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
    splits,
    judgeAgreement,
    warnings: [...new Set(results.flatMap((r) => r.warnings.map((w) => `${r.case}: ${w}`)))],
  };
}

const f2 = (x: number) => (Number.isNaN(x) ? '–' : x.toFixed(2));
const pct = (x: number) => (Number.isNaN(x) ? '–' : `${Math.round(x * 100)}%`);

export function reportMarkdown(r: Report): string {
  const out: string[] = ['# prbench report', ''];
  out.push(`Rubric v${r.rubricVersion}. Judges: ${r.judges.join(', ')}. Generated ${r.generatedAt}.`, '');
  out.push(
    'Each pair is judged in both orders; a win needs both orders to agree, otherwise it is a tie (a *flip* when the orders picked opposite systems). ' +
      `"${AGREE}" counts a win only when every judge gave it. With few cases, treat p-values and intervals as a sense of scale, not proof.`,
    '',
  );
  for (const [split, s] of Object.entries(r.splits)) {
    out.push(`## ${split} split (${s.cases.length} case${s.cases.length === 1 ? '' : 's'})`, '', s.cases.join(', '), '');
    out.push('### Head to head', '');
    out.push('| x vs y | judge | x wins | y wins | ties | flips | x win rate | sign test p | mean (x−y) [95% CI] |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    for (const p of s.pairs) {
      out.push(
        `| ${p.x} vs ${p.y} | ${p.judge} | ${p.xWins} | ${p.yWins} | ${p.ties} | ${p.flips} | ${pct(p.winRate)} | ${f2(p.signP)} | ${f2(p.meanDiff)} [${f2(p.ci[0])}, ${f2(p.ci[1])}] |`,
      );
    }
    out.push('', '### Per system (means over every judgment of that system)', '');
    out.push('| system | judgments | factual errors | unsupported claims | claims covered | context covered | uncertainties respected | traps hit | median words | agent cost |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const x of s.systems) {
      out.push(
        `| ${x.system} | ${x.judgments} | ${f2(x.factualErrors)} | ${f2(x.unsupportedClaims)} | ${pct(x.claimCoverage)} | ${pct(x.contextCoverage)} | ${pct(x.uncertaintiesRespected)} | ${f2(x.trapsHit)} | ${Number.isNaN(x.medianWords) ? '–' : x.medianWords} | ${x.costUsd === undefined ? '–' : `$${x.costUsd.toFixed(2)}`} |`,
      );
    }
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
