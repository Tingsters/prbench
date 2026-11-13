/**
 * Paired comparison of two finished `compare` runs (A and B) that share a
 * provider, writer model, cases and replicates but differ in their candidate
 * skill. Each run is first reduced to its own candidate-vs-baseline result per
 * (case, replicate), then the two runs are compared pair by pair:
 *
 * - consensus outcome: +1 when every judge picked the candidate in both orders,
 *   −1 when every judge picked the baseline, 0 otherwise (the `compare`
 *   quality-gate rule, via `agreedResults`);
 * - composite Δ-of-Δ: (A cand − A base) − (B cand − B base), with a
 *   case-clustered bootstrap interval (5000 resamples, seed 7);
 * - factual-error means per arm, and per-case Δ-of-Δ.
 *
 * Usage:
 *   bun run scripts/paired-delta.ts <runA> <runB> [--dataset id@version | --cases dir] [--model m] [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { modelRoot, type ComparisonManifest } from "../src/comparison.ts";
import { resolveDatasetInputs } from "../src/datasets.ts";
import type { PairResult } from "../src/judge/pairwise.ts";
import { agreedResults } from "../src/report.ts";
import { caseClustered, collectDraftScores, type DraftScore, type ItemCounts } from "../src/report/score.ts";
import { caseDirs, loadCase, loadFacts } from "../src/schema/case.ts";

export const CANDIDATE = "tracetoon-candidate";
export const BASELINE = "tracetoon-baseline";
export const SEED = 7;

/** One run's per-(case, replicate) result against its own baseline. */
export interface RunPair {
  case: string;
  replicate: number;
  /** +1 candidate consensus win, −1 baseline consensus win, 0 otherwise. */
  outcome: number;
  candidate?: DraftScore;
  baseline?: DraftScore;
}

export interface RunData {
  root: string;
  model: string;
  pairs: RunPair[];
}

const key = (c: string, r: number) => `${c}\u0000${r}`;

/** Consensus outcome of one (case, replicate) from its per-judge pair results. */
export function consensusOutcome(results: PairResult[], judges: string[], candidate = CANDIDATE, baseline = BASELINE): number {
  const agreed = agreedResults(results, judges)[0];
  if (!agreed) return 0;
  return agreed.verdict === candidate ? 1 : agreed.verdict === baseline ? -1 : 0;
}

/** Loads a compare output: consensus from each replicate's `pairs.json`, scores via `collectDraftScores`. */
export function loadRun(dir: string, factsFor: (id: string) => ItemCounts | undefined, model?: string): RunData {
  const root = resolve(dir);
  const manifestFile = join(root, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`No manifest.json in ${root}`);
  const m = JSON.parse(readFileSync(manifestFile, "utf8")) as ComparisonManifest;
  const models = m.settings.models;
  const chosen = model ?? (models.length === 1 ? models[0]! : undefined);
  if (!chosen || !models.includes(chosen))
    throw new Error(`${root}: choose one writer model with --model (${models.join(", ")})`);
  const judges = m.settings.judges;
  const drafts = collectDraftScores(root, factsFor).filter((d) => d.model === chosen);
  const score = (c: string, r: number, s: string) => drafts.find((d) => d.case === c && d.replicate === r && d.system === s);
  const pairs: RunPair[] = [];
  for (let r = 1; r <= m.settings.replicates; r++) {
    const file = join(modelRoot(root, r, chosen), BASELINE, "pairs.json");
    if (!existsSync(file)) continue;
    const results = JSON.parse(readFileSync(file, "utf8")) as PairResult[];
    for (const c of [...new Set(results.map((p) => p.case))])
      pairs.push({
        case: c,
        replicate: r,
        outcome: consensusOutcome(results.filter((p) => p.case === c), judges),
        candidate: score(c, r, CANDIDATE),
        baseline: score(c, r, BASELINE),
      });
  }
  return { root, model: chosen, pairs };
}

const delta = (p: RunPair) =>
  p.candidate && p.baseline ? p.candidate.composite - p.baseline.composite : NaN;

export interface PairedDelta {
  a: string;
  b: string;
  pairs: number;
  aBetter: number;
  bBetter: number;
  equal: number;
  /** Consensus W/T/L of each run against its own baseline, over the shared pairs. */
  consensus: { a: [number, number, number]; b: [number, number, number] };
  composite: { aCandidate: number; aBaseline: number; bCandidate: number; bBaseline: number };
  deltaOfDelta: { mean: number; ci: [number, number]; cases: number; drafts: number };
  factualErrors: { aCandidate: number; aBaseline: number; bCandidate: number; bBaseline: number };
  perCase: { case: string; pairs: number; aBetter: number; bBetter: number; equal: number; deltaOfDelta: number }[];
}

/** Compares two runs over the (case, replicate) pairs both have. */
export function pairedDelta(a: RunData, b: RunData): PairedDelta {
  const bByKey = new Map(b.pairs.map((p) => [key(p.case, p.replicate), p]));
  const shared = a.pairs
    .filter((p) => bByKey.has(key(p.case, p.replicate)))
    .map((pa) => ({ a: pa, b: bByKey.get(key(pa.case, pa.replicate))! }))
    .sort((x, y) => x.a.case.localeCompare(y.a.case, undefined, { numeric: true }) || x.a.replicate - y.a.replicate);
  const wtl = (os: number[]): [number, number, number] => [
    os.filter((o) => o > 0).length,
    os.filter((o) => o === 0).length,
    os.filter((o) => o < 0).length,
  ];
  const cmp = (rows: typeof shared) => ({
    aBetter: rows.filter((s) => s.a.outcome > s.b.outcome).length,
    bBetter: rows.filter((s) => s.a.outcome < s.b.outcome).length,
    equal: rows.filter((s) => s.a.outcome === s.b.outcome).length,
  });
  const dd = shared.map((s) => ({ case: s.a.case, value: delta(s.a) - delta(s.b) }));
  const arm = (pick: (s: (typeof shared)[number]) => DraftScore | undefined, field: "composite" | "factualErrors") =>
    caseClustered(shared.map((s) => ({ case: s.a.case, value: pick(s)?.[field] ?? NaN }))).mean;
  const cases = [...new Set(shared.map((s) => s.a.case))];
  return {
    a: a.root,
    b: b.root,
    pairs: shared.length,
    ...cmp(shared),
    consensus: { a: wtl(shared.map((s) => s.a.outcome)), b: wtl(shared.map((s) => s.b.outcome)) },
    composite: {
      aCandidate: arm((s) => s.a.candidate, "composite"),
      aBaseline: arm((s) => s.a.baseline, "composite"),
      bCandidate: arm((s) => s.b.candidate, "composite"),
      bBaseline: arm((s) => s.b.baseline, "composite"),
    },
    deltaOfDelta: caseClustered(dd, SEED),
    factualErrors: {
      aCandidate: arm((s) => s.a.candidate, "factualErrors"),
      aBaseline: arm((s) => s.a.baseline, "factualErrors"),
      bCandidate: arm((s) => s.b.candidate, "factualErrors"),
      bBaseline: arm((s) => s.b.baseline, "factualErrors"),
    },
    perCase: cases.map((c) => {
      const rows = shared.filter((s) => s.a.case === c);
      return { case: c, pairs: rows.length, ...cmp(rows), deltaOfDelta: caseClustered(dd.filter((d) => d.case === c)).mean };
    }),
  };
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const sg = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) : "–");

export function pairedDeltaMarkdown(r: PairedDelta): string {
  const [lo, hi] = r.deltaOfDelta.ci;
  return [
    `# Paired delta: A vs B`,
    "",
    `- A: \`${r.a}\``,
    `- B: \`${r.b}\``,
    "",
    "Each run is compared with its own baseline per (case, replicate); outcome is +1 when every judgment prefers the candidate, −1 when every judgment prefers the baseline, 0 otherwise.",
    "",
    "| Pairs | A better | B better | Equal | A W/T/L | B W/T/L | Composite Δ-of-Δ [95% CI] |",
    "|---|---|---|---|---|---|---|",
    `| ${r.pairs} | ${r.aBetter} | ${r.bBetter} | ${r.equal} | ${r.consensus.a.join("/")} | ${r.consensus.b.join("/")} | ${sg(r.deltaOfDelta.mean)} [${sg(lo)}, ${sg(hi)}] |`,
    "",
    "| Arm | Composite | Factual errors / judgment |",
    "|---|---|---|",
    `| A candidate | ${f1(r.composite.aCandidate)} | ${f2(r.factualErrors.aCandidate)} |`,
    `| A baseline | ${f1(r.composite.aBaseline)} | ${f2(r.factualErrors.aBaseline)} |`,
    `| B candidate | ${f1(r.composite.bCandidate)} | ${f2(r.factualErrors.bCandidate)} |`,
    `| B baseline | ${f1(r.composite.bBaseline)} | ${f2(r.factualErrors.bBaseline)} |`,
    "",
    "| Case | Pairs | A better | B better | Equal | Δ-of-Δ |",
    "|---|---|---|---|---|---|",
    ...r.perCase.map((c) => `| ${c.case} | ${c.pairs} | ${c.aBetter} | ${c.bBetter} | ${c.equal} | ${sg(c.deltaOfDelta)} |`),
    "",
    `Δ-of-Δ = (A cand − A base) − (B cand − B base); interval is a case bootstrap (5000 resamples, seed ${SEED}).`,
  ].join("\n");
}

async function main(argv: string[]) {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const json = argv.includes("--json");
  if (json) argv.splice(argv.indexOf("--json"), 1);
  const cases = flag("--cases"),
    dataset = flag("--dataset"),
    model = flag("--model");
  if (argv.length !== 2) {
    console.error("usage: bun run scripts/paired-delta.ts <runA> <runB> [--dataset id@version | --cases dir] [--model m] [--json]");
    process.exit(2);
  }
  const inputs = await resolveDatasetInputs({ cases, dataset });
  const facts = new Map<string, ItemCounts>();
  for (const dir of caseDirs(resolve(inputs.cases))) {
    try {
      const l = loadCase(dir);
      const f = loadFacts(l);
      if (f) facts.set(l.case.id, f);
    } catch {
      // Cases that fail to load have no facts and are not scored, as in `prbench score`.
    }
  }
  const factsFor = (id: string) => facts.get(id);
  const result = pairedDelta(loadRun(argv[0]!, factsFor, model), loadRun(argv[1]!, factsFor, model));
  console.log(json ? JSON.stringify(result, null, 2) : pairedDeltaMarkdown(result));
}

if (import.meta.main) await main(process.argv.slice(2));
