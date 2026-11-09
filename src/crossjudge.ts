/**
 * Cross-run judging: candidate drafts from one finished comparison against
 * baseline drafts from another, typically written by different models. No
 * writer runs; the saved artifacts of both runs are judged pairwise with the
 * judges, rubric and judge contract the two runs share, in both orders, and
 * summarised with the same consensus rule `compare` uses for its quality gate
 * (a win only when every judge's two orders agree on the same draft).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { modelRoot, type ComparisonManifest } from "./comparison.ts";
import { judgePair, judgmentPath, type PairResult, type StoredJudgment } from "./judge/pairwise.ts";
import { parseJudge, type JudgeProvider } from "./judge/providers.ts";
import { RUBRIC_VERSION } from "./judge/rubric.ts";
import { agreedResults } from "./report.ts";
import { composite, sideComponents, type Components } from "./report/score.ts";
import { StageCache, implementationDigest } from "./run/cache.ts";
import { atomicJson } from "./run/ledger.ts";
import { runPool, type PoolJob } from "./run/pool.ts";
import { artifactDigest, checkArtifact, type PRArtifact } from "./schema/artifact.ts";
import { loadCase, loadFacts, type Facts, type LoadedCase } from "./schema/case.ts";

export const CANDIDATE = "tracetoon-candidate";
export const BASELINE = "tracetoon-baseline";
/** Same entries `compare` freezes as its judge contract. */
export const JUDGE_ENTRIES = ["package.json", "bun.lock", "tsconfig.json", "src/judge/pairwise.ts", "src/agents/windows-job.cs"];

export interface CrossJudgeOptions {
  candidate: string;
  baseline: string;
  out: string;
  cache?: string;
  plan?: boolean;
  parallel?: number;
  /** Test seam: judge provider per configured judge spec. */
  judgeFor?: (spec: string) => JudgeProvider;
  /** Harness root whose judge contract must match the runs (default: this checkout). */
  harness?: string;
  log?: (line: string) => void;
}

interface Run {
  root: string;
  manifest: ComparisonManifest;
  model: string;
}

function readRun(dir: string, role: string): Run {
  const root = resolve(dir);
  const file = join(root, "manifest.json");
  if (!existsSync(file)) throw new Error(`${role} run has no manifest.json: ${root}`);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as ComparisonManifest;
  if (manifest.schema !== "prbench.comparison/v2") throw new Error(`${role} run is not a prbench.comparison/v2 experiment.`);
  if (manifest.settings.models.length !== 1)
    throw new Error(`${role} run must have exactly one writer model, found ${manifest.settings.models.join(", ")}.`);
  return { root, manifest, model: manifest.settings.models[0]! };
}

/** Every control that must match for the two runs' drafts to be judged together. */
export function manifestDifferences(a: ComparisonManifest, b: ComparisonManifest): string[] {
  const out: string[] = [];
  const cmp = (name: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${name}: candidate ${JSON.stringify(x)} vs baseline ${JSON.stringify(y)}`);
  };
  cmp("judgeContract", a.judgeContract, b.judgeContract);
  cmp("judges", a.settings.judges, b.settings.judges);
  cmp("rubricVersion", a.settings.rubricVersion, b.settings.rubricVersion);
  cmp("replicates", a.settings.replicates, b.settings.replicates);
  cmp("split", a.split, b.split);
  const cases = (m: ComparisonManifest) => [...m.cases].map((c) => `${c.id}@${c.hash}`).sort();
  cmp("cases", cases(a), cases(b));
  return out;
}

const pad = (r: number) => `replicate-${String(r).padStart(3, "0")}`;
const avg = (xs: number[]) => {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};

function loadDraft(run: Run, replicate: number, caseId: string, system: string): PRArtifact {
  const file = join(modelRoot(run.root, replicate, run.model), "artifacts", caseId, `${system}.json`);
  if (!existsSync(file)) throw new Error(`Missing draft ${file}`);
  const artifact = JSON.parse(readFileSync(file, "utf8")) as PRArtifact;
  const receiptFile = file.replace(/\.json$/, ".receipt.json");
  const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, "utf8")) : undefined;
  const problems = checkArtifact(artifact);
  if (problems.length || artifact.case !== caseId || artifact.system !== system)
    throw new Error(`Saved draft identity is invalid: ${file} ${problems.join("; ")}`);
  if (!receipt || receipt.digest !== artifactDigest(artifact) || receipt.experiment !== run.manifest.id)
    throw new Error(`Saved draft does not match its receipt: ${file}`);
  return artifact;
}

export interface DraftSummary extends Components {
  judgments: number;
  composite: number;
  /** Share of judgments reporting at least one factual error. */
  errorRate: number;
}

function draftSummary(sides: PairResult["sides"][string], facts: Facts): DraftSummary {
  const comps = sides.map((s) => sideComponents(s, facts));
  const k = (key: keyof Components) => avg(comps.map((c) => c[key]));
  return {
    claims: k("claims"),
    context: k("context"),
    uncertainties: k("uncertainties"),
    rubric: k("rubric"),
    factualErrors: k("factualErrors"),
    unsupportedClaims: k("unsupportedClaims"),
    traps: k("traps"),
    judgments: comps.length,
    composite: avg(comps.map(composite)),
    errorRate: avg(comps.map((c) => (c.factualErrors > 0 ? 1 : 0))),
  };
}

export interface Tally {
  wins: number;
  ties: number;
  losses: number;
  inconclusive: number;
  flips: number;
}
const tally = (): Tally => ({ wins: 0, ties: 0, losses: 0, inconclusive: 0, flips: 0 });
function count(t: Tally, r: PairResult) {
  if (r.verdict === CANDIDATE) t.wins++;
  else if (r.verdict === BASELINE) t.losses++;
  else if (r.verdict === "inconclusive") t.inconclusive++;
  else t.ties++;
  if (r.flipped) t.flips++;
}

export interface CrossRow {
  replicate: number;
  case: string;
  consensus: string;
  verdicts: Record<string, string>;
  candidate: DraftSummary;
  baseline: DraftSummary;
}

export interface CrossSummary {
  schema: "prbench.crossjudge/v1";
  generatedAt: string;
  candidate: { run: string; experiment: string; model: string; system: string };
  baseline: { run: string; experiment: string; model: string; system: string };
  judges: string[];
  judgeContract: string;
  rubricVersion: number;
  replicates: number;
  cases: string[];
  /** Wins/losses are the candidate's (y) against the baseline (x). */
  consensus: Tally;
  byJudge: Record<string, Tally>;
  byCase: Record<string, { consensus: Tally; candidate: { composite: number; factualErrors: number }; baseline: { composite: number; factualErrors: number } }>;
  sides: { candidate: DraftSummary & { drafts: number }; baseline: DraftSummary & { drafts: number } };
  rows: CrossRow[];
  judgeCostUsd: number;
  judgmentsCosted: number;
  orders: number;
  newJudgeCalls: number;
}

function sideAggregate(list: DraftSummary[]): DraftSummary & { drafts: number } {
  const k = (key: keyof DraftSummary) => avg(list.map((d) => d[key]));
  return {
    claims: k("claims"),
    context: k("context"),
    uncertainties: k("uncertainties"),
    rubric: k("rubric"),
    factualErrors: k("factualErrors"),
    unsupportedClaims: k("unsupportedClaims"),
    traps: k("traps"),
    judgments: list.reduce((s, d) => s + d.judgments, 0),
    composite: k("composite"),
    errorRate: k("errorRate"),
    drafts: list.length,
  };
}

export async function crossJudge(opts: CrossJudgeOptions): Promise<{ plan: { calls: number; pairs: number } } | CrossSummary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const cand = readRun(opts.candidate, "Candidate"),
    base = readRun(opts.baseline, "Baseline");
  const diffs = manifestDifferences(cand.manifest, base.manifest);
  if (diffs.length) throw new Error(`Runs are not comparable:\n  ${diffs.join("\n  ")}`);
  const m = base.manifest;
  if (m.settings.rubricVersion !== RUBRIC_VERSION)
    throw new Error(`Runs used rubric v${m.settings.rubricVersion}; this harness judges v${RUBRIC_VERSION}.`);
  const harness = opts.harness ?? resolve(import.meta.dir, "..");
  const contract = implementationDigest(harness, JUDGE_ENTRIES);
  if (contract !== m.judgeContract)
    throw new Error(`This harness's judge contract ${contract} differs from the runs' ${m.judgeContract}; check out the judging code they used.`);
  const out = resolve(opts.out);
  const JUDGES = m.settings.judges,
    R = m.settings.replicates;
  const loaded: { l: LoadedCase; facts: Facts }[] = m.cases.map((c) => {
    const l = loadCase(join(base.root, "inputs", "cases", c.id));
    const facts = loadFacts(l);
    if (!facts) throw new Error(`Case ${c.id} has no fact sheet.`);
    return { l, facts };
  });
  // Load and verify every draft up front, so a missing one fails before any call.
  const drafts = new Map<string, { x: PRArtifact; y: PRArtifact }>();
  const missing: string[] = [];
  for (let r = 1; r <= R; r++)
    for (const { l } of loaded)
      try {
        drafts.set(`${r}/${l.case.id}`, {
          x: loadDraft(base, r, l.case.id, BASELINE),
          y: loadDraft(cand, r, l.case.id, CANDIDATE),
        });
      } catch (error) {
        missing.push(String(error instanceof Error ? error.message : error));
      }
  if (missing.length) throw new Error(`Cannot pair every draft:\n  ${missing.join("\n  ")}`);
  const pairs = R * loaded.length * JUDGES.length;
  const plan = { calls: pairs * 2, pairs };
  log(
    `crossjudge: ${CANDIDATE}@${cand.model} (${cand.root}) vs ${BASELINE}@${base.model} (${base.root}); ` +
      `${R} replicate(s) x ${loaded.length} case(s) x ${JUDGES.length} judge(s) x 2 orders = ${plan.calls} judge calls`,
  );
  if (opts.plan) return { plan };

  mkdirSync(out, { recursive: true });
  const provenance = {
    schema: "prbench.crossjudge-inputs/v1",
    candidate: { run: cand.root, experiment: cand.manifest.id, model: cand.model, system: CANDIDATE },
    baseline: { run: base.root, experiment: base.manifest.id, model: base.model, system: BASELINE },
    judges: JUDGES,
    judgeContract: m.judgeContract,
    rubricVersion: RUBRIC_VERSION,
    replicates: R,
    cases: m.cases.map((c) => ({ id: c.id, hash: c.hash })),
  };
  const inputsFile = join(out, "crossjudge.json");
  if (existsSync(inputsFile) && JSON.stringify(JSON.parse(readFileSync(inputsFile, "utf8"))) !== JSON.stringify(provenance))
    throw new Error(`${out} holds a different cross-judge; use a new --out.`);
  atomicJson(inputsFile, provenance);
  const cache = new StageCache(resolve(opts.cache ?? join(dirname(out), ".prbench-cache", "v2")));
  const results = new Map<string, PairResult>();
  let newJudgeCalls = 0,
    finished = 0;
  const jobs: PoolJob[] = [];
  for (let r = 1; r <= R; r++)
    for (const { l, facts } of loaded)
      for (const spec of JUDGES) {
        const label = `judge r${r} ${l.case.id}/${spec}`;
        jobs.push({
          id: `${r}/${l.case.id}/${spec}`,
          label,
          deps: [],
          priority: -jobs.length,
          run: async () => {
            const provider = (opts.judgeFor ?? parseJudge)(spec);
            const observed: JudgeProvider = {
              ...provider,
              ask: (prompt, schema) => {
                newJudgeCalls++;
                log(`call ${label}`);
                return provider.ask(prompt, schema);
              },
            };
            const { x, y } = drafts.get(`${r}/${l.case.id}`)!;
            const pair = await judgePair({
              loaded: l,
              facts,
              x,
              y,
              judge: observed,
              outDir: join(out, pad(r), "judgments"),
              controls: { cache, contract: m.judgeContract, ledgerRoot: out },
            });
            results.set(`${r}/${l.case.id}/${spec}`, pair);
            finished++;
            log(`ok    [${finished}/${pairs}] r${r} ${l.case.id} [${spec}]: ${pair.verdict}${pair.flipped ? " (flipped)" : ""}`);
          },
        });
      }
  try {
    await runPool(jobs, { limit: opts.parallel ?? 4 });
  } finally {
    // Keep finished pairs in a fixed order even when a later job failed.
    const ordered: (PairResult & { replicate: number })[] = [];
    for (let r = 1; r <= R; r++)
      for (const { l } of loaded)
        for (const spec of JUDGES) {
          const p = results.get(`${r}/${l.case.id}/${spec}`);
          if (p) ordered.push({ replicate: r, ...p, model: undefined, models: { [BASELINE]: base.model, [CANDIDATE]: cand.model } } as PairResult & { replicate: number });
        }
    atomicJson(join(out, "pairs.json"), ordered);
  }

  // Summary.
  const consensus = tally(),
    byJudge: Record<string, Tally> = Object.fromEntries(JUDGES.map((j) => [j, tally()]));
  const rows: CrossRow[] = [];
  let judgeCostUsd = 0,
    judgmentsCosted = 0;
  for (let r = 1; r <= R; r++)
    for (const { l, facts } of loaded) {
      const ps = JUDGES.map((j) => results.get(`${r}/${l.case.id}/${j}`)!);
      ps.forEach((p, i) => count(byJudge[JUDGES[i]!]!, p));
      const agreed = agreedResults(ps, JUDGES)[0]!;
      count(consensus, agreed);
      for (const p of ps)
        for (const order of ["ab", "ba"] as const) {
          const stored = JSON.parse(
            readFileSync(judgmentPath(join(out, pad(r), "judgments"), l.case.id, p.judge, BASELINE, CANDIDATE, order), "utf8"),
          ) as StoredJudgment;
          if (typeof stored.costUsd === "number") {
            judgeCostUsd += stored.costUsd;
            judgmentsCosted++;
          }
        }
      rows.push({
        replicate: r,
        case: l.case.id,
        consensus: agreed.verdict,
        verdicts: Object.fromEntries(ps.map((p) => [p.judge, p.verdict])),
        candidate: draftSummary(ps.flatMap((p) => p.sides[CANDIDATE]!), facts),
        baseline: draftSummary(ps.flatMap((p) => p.sides[BASELINE]!), facts),
      });
    }
  const byCase: CrossSummary["byCase"] = {};
  for (const { l } of loaded) {
    const rs = rows.filter((row) => row.case === l.case.id);
    const t = tally();
    for (const row of rs) count(t, { verdict: row.consensus, flipped: false } as PairResult);
    byCase[l.case.id] = {
      consensus: t,
      candidate: { composite: avg(rs.map((x) => x.candidate.composite)), factualErrors: avg(rs.map((x) => x.candidate.factualErrors)) },
      baseline: { composite: avg(rs.map((x) => x.baseline.composite)), factualErrors: avg(rs.map((x) => x.baseline.factualErrors)) },
    };
  }
  const summary: CrossSummary = {
    schema: "prbench.crossjudge/v1",
    generatedAt: new Date().toISOString(),
    candidate: provenance.candidate,
    baseline: provenance.baseline,
    judges: JUDGES,
    judgeContract: m.judgeContract,
    rubricVersion: RUBRIC_VERSION,
    replicates: R,
    cases: loaded.map(({ l }) => l.case.id),
    consensus,
    byJudge,
    byCase,
    sides: { candidate: sideAggregate(rows.map((r) => r.candidate)), baseline: sideAggregate(rows.map((r) => r.baseline)) },
    rows,
    judgeCostUsd,
    judgmentsCosted,
    orders: results.size * 2,
    newJudgeCalls,
  };
  atomicJson(join(out, "summary.json"), summary);
  writeFileSync(join(out, "summary.md"), crossMarkdown(summary));
  return summary;
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");
const wtl = (t: Tally) => `${t.wins}/${t.ties}/${t.losses}${t.inconclusive ? ` (+${t.inconclusive} inconclusive)` : ""}`;

export function crossMarkdown(s: CrossSummary): string {
  const c = `${s.candidate.system}@${s.candidate.model}`,
    b = `${s.baseline.system}@${s.baseline.model}`;
  const lines = [
    `# Cross-judge: ${c} vs ${b}`,
    "",
    `- Candidate: ${s.candidate.run} (experiment ${s.candidate.experiment.slice(0, 12)})`,
    `- Baseline: ${s.baseline.run} (experiment ${s.baseline.experiment.slice(0, 12)})`,
    `- Judges: ${s.judges.join(", ")}; rubric v${s.rubricVersion}; ${s.replicates} replicate(s) x ${s.cases.length} case(s); ${s.orders} order judgments (${s.newJudgeCalls} new calls this session)`,
    `- Judge cost: $${s.judgeCostUsd.toFixed(2)} over ${s.judgmentsCosted} costed judgment(s)`,
    "",
    "A consensus win needs every judge's two orders to pick the same draft (the `compare` quality-gate rule). W/T/L is the candidate's.",
    "",
    `**Consensus W/T/L: ${wtl(s.consensus)}** (flipped pairs: ${s.consensus.flips})`,
    "",
    "| Judge | W/T/L | Flips |",
    "|---|---|---|",
    ...Object.entries(s.byJudge).map(([j, t]) => `| ${j} | ${wtl(t)} | ${t.flips} |`),
    "",
    "## Per case",
    "",
    "| Case | Consensus W/T/L | Candidate composite | Baseline composite | Candidate errors | Baseline errors |",
    "|---|---|---|---|---|---|",
    ...Object.entries(s.byCase).map(
      ([id, v]) => `| ${id} | ${wtl(v.consensus)} | ${f1(v.candidate.composite)} | ${f1(v.baseline.composite)} | ${f2(v.candidate.factualErrors)} | ${f2(v.baseline.factualErrors)} |`,
    ),
    "",
    "## Per draft side (mean over drafts; each draft is the mean of its judgments)",
    "",
    "| Side | Drafts | Composite | Factual errors | Error rate | Unsupported | Claims | Context | Uncertainties | Rubric | Traps |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...([["Candidate " + c, s.sides.candidate], ["Baseline " + b, s.sides.baseline]] as const).map(
      ([n, d]) =>
        `| ${n} | ${d.drafts} | ${f1(d.composite)} | ${f2(d.factualErrors)} | ${pct(d.errorRate)} | ${f2(d.unsupportedClaims)} | ${pct(d.claims)} | ${pct(d.context)} | ${pct(d.uncertainties)} | ${pct(d.rubric)} | ${f2(d.traps)} |`,
    ),
    "",
    "## Rows",
    "",
    "| Replicate | Case | Consensus | " + s.judges.join(" | ") + " | Cand. composite | Base. composite |",
    "|---|---|---|" + s.judges.map(() => "---|").join("") + "---|---|",
    ...s.rows.map(
      (r) =>
        `| ${r.replicate} | ${r.case} | ${r.consensus} | ${s.judges.map((j) => r.verdicts[j]).join(" | ")} | ${f1(r.candidate.composite)} | ${f1(r.baseline.composite)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
