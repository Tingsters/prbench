/**
 * Absolute per-draft scores from saved judgments.
 *
 * Every v6 pairwise judgment already grades each side on its own: fact-sheet
 * coverage (claims, context, uncertainties), traps, factual errors,
 * unsupported claims and a 0-2 rubric. Preference only says which of two
 * drafts was better; these scores say how good each one is, so runs and
 * iterations can be compared on one scale. A draft's score is the mean over
 * every judgment of it (all judges, both orders, every pairing).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { codexUsageFromDir, type CodexUsage } from "../agents/codexUsage.ts";
import type { SideJudgment } from "../judge/rubric.ts";
import type { Facts } from "../schema/case.ts";
import { bootstrapMeanCI, mean } from "../stats.ts";
import PRICES from "./prices.json" with { type: "json" };

/** Composite weights. Coverage and rubric add up to 100; mistakes subtract. */
export const WEIGHTS = {
  claims: 35,
  context: 15,
  uncertainties: 15,
  rubric: 35,
  factualError: 15,
  unsupportedClaim: 7,
  trap: 10,
} as const;

export interface Components {
  /** Fraction of fact-sheet claims the draft covers. */
  claims: number;
  context: number;
  uncertainties: number;
  /** Mean rubric item over applicable items, scaled to 0-1. */
  rubric: number;
  factualErrors: number;
  unsupportedClaims: number;
  traps: number;
}

export type ItemCounts = Pick<Facts, "claims" | "context" | "uncertainties">;

const frac = (got: number, of: number) => (of > 0 ? got / of : 1);

export function sideComponents(side: SideJudgment, facts: ItemCounts): Components {
  const rubric = Object.values(side.rubric ?? {}).filter(
    (v): v is 0 | 1 | 2 => typeof v === "number",
  );
  return {
    claims: frac(side.claimsCovered.length, facts.claims.length),
    context: frac(side.contextCovered.length, facts.context.length),
    uncertainties: frac(side.uncertaintiesRespected.length, facts.uncertainties.length),
    rubric: rubric.length ? mean(rubric) / 2 : NaN,
    factualErrors: side.factualErrors.length,
    unsupportedClaims: side.unsupportedClaims.length,
    traps: side.trapsHit.length,
  };
}

/** 0-100. Missing rubric counts as its coverage-only share rescaled. */
export function composite(c: Components): number {
  const w = WEIGHTS;
  const parts: [number, number][] = [
    [w.claims, c.claims],
    [w.context, c.context],
    [w.uncertainties, c.uncertainties],
  ];
  if (Number.isFinite(c.rubric)) parts.push([w.rubric, c.rubric]);
  const total = parts.reduce((s, [k]) => s + k, 0);
  const positive = (100 * parts.reduce((s, [k, v]) => s + k * v, 0)) / total;
  return Math.max(
    0,
    positive -
      w.factualError * c.factualErrors -
      w.unsupportedClaim * c.unsupportedClaims -
      w.trap * c.traps,
  );
}

export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}
const PRICE_TABLE = PRICES as unknown as { models: Record<string, Price> };

/** USD for one run from token counts (prices per million tokens). Cached tokens are part of input. */
export function estimateCost(
  model: string,
  t: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number },
  table: Record<string, Price> = PRICE_TABLE.models,
): number | undefined {
  const p = table[model];
  if (!p || t.inputTokens === undefined) return undefined;
  const cached = Math.min(t.cachedInputTokens ?? 0, t.inputTokens);
  return (
    ((t.inputTokens - cached) * p.input +
      cached * p.cachedInput +
      (t.outputTokens ?? 0) * p.output) /
    1e6
  );
}

export interface DraftScore extends Components {
  model: string;
  replicate: number;
  case: string;
  system: string;
  judgments: number;
  judges: string[];
  composite: number;
  costUsd?: number;
  costSource?: "reported" | "estimated";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /**
   * What the tokens and estimated cost cover: "all-threads" includes every
   * subagent thread; "main-thread" is a Codex draft whose subagent usage is
   * unknown (no saved traces). Undefined for reported costs.
   */
  usageScope?: "all-threads" | "main-thread";
  /** Where all-thread usage came from: the artifact itself or its saved writer traces. */
  usageSource?: "artifact" | "traces";
  subagentThreads?: number;
  graphQueries?: number;
  /** Share of this draft's judgments that found at least one factual error. */
  errorRate: number;
  /** Mean factual errors per judgment, by class (see ERROR_CLASSES). */
  errorClasses: Record<string, number>;
}

/**
 * Coarse classes of factual errors, matched in order against the judge's
 * error text. Diagnostic only: they show which kind of statement goes wrong.
 */
export const ERROR_CLASSES: [string, RegExp][] = [
  ["validation", /\b(pass(es|ed)?|fail(s|ed|ures?)?|tests?|typecheck|tsc|bundle|lint|build|ran|runs?|recorded|exercised|verified|checks?)\b/i],
  ["code structure", /branch|fallback/i],
  ["attribution", /match|authored|wrote|agent edit|%|percent|session/i],
  ["motivation", /because|found while|so that|motivat|reason/i],
  ["pipeline", /comic|render|tracetoon/i],
];

export function errorClass(text: string): string {
  return ERROR_CLASSES.find(([, rx]) => rx.test(text))?.[0] ?? "other";
}

interface SavedJudgment {
  rubricVersion?: string;
  judge: string;
  case: string;
  labels: { A: string; B: string };
  judgment?: { A: SideJudgment; B: SideJudgment };
}

/**
 * Final judgment files under a `judgments` folder. `<order>.json.attempts/`
 * folders hold raw judge attempts, and their `NNN.accepted.json` is a byte copy
 * of the final judgment, so they are skipped to count each judgment once.
 */
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!name.endsWith(".attempts")) yield* files(p);
    }
    else if (name.endsWith(".json")) yield p;
  }
}

/** `judgments` folders under a results root, skipping raw attempts and frozen inputs. */
function judgmentDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      if (["attempts", "inputs", "derived-reports", ".scope-audits"].includes(name)) continue;
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      if (name === "judgments") out.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Per-draft scores for one results root: a compare output
 * (`[replicate-00N/]<model>/<comparison>/judgments/…`) or a standalone judge
 * output (`<model>/judgments/…` or `judgments/…`).
 */
export function collectDraftScores(
  root: string,
  factsFor: (caseId: string) => ItemCounts | undefined,
  rubricVersion = "6",
): DraftScore[] {
  type Acc = {
    key: Omit<DraftScore, keyof Components | "composite" | "judgments" | "judges" | "errorRate" | "errorClasses">;
    comps: Components[];
    classes: Record<string, number>;
    judges: Set<string>;
    artifactDir?: string;
  };
  const acc = new Map<string, Acc>();
  for (const dir of judgmentDirs(root)) {
    const segs = relative(root, dir).split(sep).slice(0, -1);
    const rep = segs[0]?.match(/^replicate-(\d+)$/);
    const rest = rep ? segs.slice(1) : segs;
    const model = rest[0] ?? "(unknown)";
    const replicate = rep ? Number(rep[1]) : 1;
    const modelDir = join(root, ...segs.slice(0, rep ? 2 : 1));
    for (const f of files(dir)) {
      let j: SavedJudgment;
      try {
        j = JSON.parse(readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      if (!j.judgment || !j.labels || String(j.rubricVersion) !== rubricVersion) continue;
      const facts = factsFor(j.case);
      if (!facts) continue;
      for (const side of ["A", "B"] as const) {
        const system = j.labels[side];
        const id = [model, replicate, j.case, system].join("\u0000");
        let a = acc.get(id);
        if (!a) {
          a = {
            key: { model, replicate, case: j.case, system },
            comps: [],
            classes: {},
            judges: new Set(),
            artifactDir: join(modelDir, "artifacts", j.case),
          };
          acc.set(id, a);
        }
        a.comps.push(sideComponents(j.judgment[side], facts));
        for (const e of j.judgment[side].factualErrors ?? []) {
          const k = errorClass(typeof e === "string" ? e : JSON.stringify(e));
          a.classes[k] = (a.classes[k] ?? 0) + 1;
        }
        a.judges.add(j.judge);
      }
    }
  }
  const drafts: DraftScore[] = [];
  for (const a of acc.values()) {
    const avg = (k: keyof Components) => {
      const v = a.comps.map((c) => c[k]).filter(Number.isFinite);
      return v.length ? mean(v) : NaN;
    };
    const comps: Components = {
      claims: avg("claims"),
      context: avg("context"),
      uncertainties: avg("uncertainties"),
      rubric: avg("rubric"),
      factualErrors: avg("factualErrors"),
      unsupportedClaims: avg("unsupportedClaims"),
      traps: avg("traps"),
    };
    const d: DraftScore = {
      ...a.key,
      ...comps,
      judgments: a.comps.length,
      judges: [...a.judges].sort(),
      composite: mean(a.comps.map(composite)),
      errorRate: mean(a.comps.map((c) => (c.factualErrors > 0 ? 1 : 0))),
      errorClasses: Object.fromEntries(Object.entries(a.classes).map(([k, n]) => [k, n / a.comps.length])),
    };
    const artifact = a.artifactDir && join(a.artifactDir, `${a.key.system}.json`);
    if (artifact && existsSync(artifact)) {
      const meta = JSON.parse(readFileSync(artifact, "utf8")).meta ?? {};
      let tokens: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } = meta;
      if (meta.agent === "codex" && typeof meta.costUsd !== "number") {
        if (meta.usageScope === "all-threads") {
          d.usageScope = "all-threads";
          d.usageSource = "artifact";
          d.subagentThreads = meta.subagentThreads;
        } else {
          const usage = writerTraceUsage(root, artifact);
          if (usage && (meta.inputTokens === undefined || usage.inputTokens >= meta.inputTokens)) {
            tokens = usage;
            d.usageScope = "all-threads";
            d.usageSource = "traces";
            d.subagentThreads = usage.subagentThreads;
          } else if (meta.inputTokens !== undefined) d.usageScope = "main-thread";
        }
      }
      d.inputTokens = tokens.inputTokens;
      d.cachedInputTokens = tokens.cachedInputTokens;
      d.outputTokens = tokens.outputTokens;
      d.graphQueries = meta.operationCounts?.["graph.queries"];
      if (typeof meta.costUsd === "number") {
        d.costUsd = meta.costUsd;
        d.costSource = "reported";
      } else {
        const est = estimateCost(String(meta.model ?? a.key.model), tokens);
        if (est !== undefined) {
          d.costUsd = est;
          d.costSource = "estimated";
        }
      }
    }
    drafts.push(d);
  }
  return drafts.sort((x, y) =>
    [x.model, x.system, x.case, x.replicate].join("|").localeCompare([y.model, y.system, y.case, y.replicate].join("|")),
  );
}

/**
 * All-thread Codex usage for a saved artifact, recomputed from the writer
 * traces of its accepted attempt: `<run>/attempts/writer/<key>/<NNN>/<case>/<system>.traces/`,
 * where the key comes from the artifact's receipt and the accepted attempt is
 * the latest one without a failure record. Lets runs saved before subagent
 * usage was counted be re-scored without new calls.
 */
export function writerTraceUsage(root: string, artifactFile: string): CodexUsage | undefined {
  const receiptFile = artifactFile.replace(/\.json$/, ".receipt.json");
  if (!existsSync(receiptFile)) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(readFileSync(receiptFile, "utf8")).key;
  } catch {
    return undefined;
  }
  if (typeof key !== "string" || !/^[0-9a-f]{16,}$/.test(key)) return undefined;
  const caseId = dirname(artifactFile).split(sep).at(-1)!;
  const system = artifactFile.split(sep).at(-1)!.replace(/\.json$/, "");
  // The run root holding `attempts/` is the artifact's nearest ancestor with one, within the scored root.
  const stop = join(root, "..");
  for (let dir = dirname(artifactFile); dir !== stop && dir !== dirname(dir); dir = dirname(dir)) {
    const keyDir = join(dir, "attempts", "writer", key);
    if (!existsSync(keyDir)) continue;
    const attempts = readdirSync(keyDir)
      .filter((n) => /^\d{3}$/.test(n))
      .sort()
      .reverse();
    for (const n of attempts) {
      if (existsSync(join(keyDir, n, "failure.json"))) continue;
      const traces = join(keyDir, n, caseId, `${system}.traces`);
      if (existsSync(traces)) return codexUsageFromDir(traces);
    }
    return undefined;
  }
  return undefined;
}

/** Mean of per-case means, with a bootstrap interval over cases (cases are the independent unit). */
export function caseClustered(rows: { case: string; value: number }[], seed = 1) {
  const byCase = new Map<string, number[]>();
  for (const r of rows) if (Number.isFinite(r.value)) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r.value]);
  const caseMeans = [...byCase.values()].map(mean);
  return {
    mean: mean(caseMeans),
    ci: caseMeans.length > 1 ? bootstrapMeanCI(caseMeans, { seed }) : ([NaN, NaN] as [number, number]),
    cases: caseMeans.length,
    drafts: rows.filter((r) => Number.isFinite(r.value)).length,
  };
}

export interface ArmScore {
  model: string;
  system: string;
  composite: ReturnType<typeof caseClustered>;
  components: Components;
  costUsd?: number;
  costSource?: string;
  inputTokens?: number;
  graphQueries?: number;
  /** What the arm's cost covers, e.g. "all threads (traces)" or "main thread only". */
  costCovers?: string;
  /** Mean subagent threads per draft, where known. */
  subagentThreads?: number;
}

/** Which threads a set of drafts' costs cover, for the report. */
export function costCovers(ds: DraftScore[]): string | undefined {
  const costed = ds.filter((d) => d.costUsd !== undefined);
  if (!costed.length) return undefined;
  const label = (d: DraftScore) =>
    d.costSource === "reported"
      ? "reported total"
      : d.usageScope === "all-threads"
        ? d.usageSource === "traces"
          ? "all threads (traces)"
          : "all threads"
        : d.usageScope === "main-thread"
          ? "main thread only"
          : "as reported in tokens";
  const labels = [...new Set(costed.map(label))];
  if (labels.length === 1) return labels[0];
  const all = costed.filter((d) => d.usageScope === "all-threads").length;
  return `mixed: ${all}/${costed.length} all threads`;
}

export function armScores(drafts: DraftScore[]): ArmScore[] {
  const groups = new Map<string, DraftScore[]>();
  for (const d of drafts) {
    const k = `${d.model}\u0000${d.system}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  return [...groups.values()].map((ds) => {
    const avg = (k: keyof Components) => caseClustered(ds.map((d) => ({ case: d.case, value: d[k] }))).mean;
    const costs = ds.map((d) => d.costUsd).filter((c): c is number => c !== undefined);
    const sources = [...new Set(ds.map((d) => d.costSource).filter(Boolean))];
    const inputs = ds.map((d) => d.inputTokens).filter((c): c is number => c !== undefined);
    const queries = ds.map((d) => d.graphQueries).filter((c): c is number => c !== undefined);
    const subs = ds.map((d) => d.subagentThreads).filter((c): c is number => c !== undefined);
    return {
      model: ds[0]!.model,
      system: ds[0]!.system,
      composite: caseClustered(ds.map((d) => ({ case: d.case, value: d.composite }))),
      components: {
        claims: avg("claims"),
        context: avg("context"),
        uncertainties: avg("uncertainties"),
        rubric: avg("rubric"),
        factualErrors: avg("factualErrors"),
        unsupportedClaims: avg("unsupportedClaims"),
        traps: avg("traps"),
      },
      costUsd: costs.length ? mean(costs) : undefined,
      costSource: sources.join("+") || undefined,
      inputTokens: inputs.length ? mean(inputs) : undefined,
      graphQueries: queries.length ? mean(queries) : undefined,
      costCovers: costCovers(ds),
      subagentThreads: subs.length ? mean(subs) : undefined,
    };
  });
}

/**
 * Range of a case-clustered mean when each case in turn is left out: how much
 * the result leans on any single case. Undefined with fewer than two cases.
 */
export function leaveOneCaseOut(rows: { case: string; value: number }[]): [number, number] | undefined {
  const cases = [...new Set(rows.filter((r) => Number.isFinite(r.value)).map((r) => r.case))];
  if (cases.length < 2) return undefined;
  const means = cases.map((left) => caseClustered(rows.filter((r) => r.case !== left)).mean);
  return [Math.min(...means), Math.max(...means)];
}

/** Candidate minus another system, paired by model, case and replicate, clustered by case. */
export function pairedDeltas(drafts: DraftScore[], candidate = "tracetoon-candidate") {
  const out: {
    model: string;
    against: string;
    delta: ReturnType<typeof caseClustered>;
    errorsDelta: number;
    /** Mean composite Δ per case, over that case's paired replicates. */
    perCase: Map<string, { mean: number; pairs: number }>;
    /** Min and max of the composite Δ with each case left out. */
    leaveOneOut?: [number, number];
  }[] = [];
  const models = [...new Set(drafts.map((d) => d.model))];
  const systems = [...new Set(drafts.map((d) => d.system))].filter((s) => s !== candidate);
  for (const model of models)
    for (const against of systems) {
      const rows: { case: string; value: number; err: number }[] = [];
      for (const c of drafts.filter((d) => d.model === model && d.system === candidate)) {
        const o = drafts.find(
          (d) => d.model === model && d.system === against && d.case === c.case && d.replicate === c.replicate,
        );
        if (o) rows.push({ case: c.case, value: c.composite - o.composite, err: c.factualErrors - o.factualErrors });
      }
      if (!rows.length) continue;
      const perCase = new Map<string, { mean: number; pairs: number }>();
      for (const c of [...new Set(rows.map((r) => r.case))].sort()) {
        const xs = rows.filter((r) => r.case === c && Number.isFinite(r.value)).map((r) => r.value);
        perCase.set(c, { mean: xs.length ? mean(xs) : NaN, pairs: xs.length });
      }
      out.push({
        model,
        against,
        delta: caseClustered(rows),
        errorsDelta: caseClustered(rows.map((r) => ({ case: r.case, value: r.err }))).mean,
        perCase,
        leaveOneOut: leaveOneCaseOut(rows),
      });
    }
  return out;
}

/**
 * Per-case composite Δ (candidate − same-model baseline), one column per
 * model, so a mean driven by one or two cases is visible.
 */
export function perCaseDeltaMarkdown(drafts: DraftScore[], candidate = "tracetoon-candidate", baseline = "tracetoon-baseline"): string {
  const deltas = pairedDeltas(drafts, candidate).filter((d) => d.against === baseline);
  if (!deltas.length) return "";
  const cases = [...new Set(deltas.flatMap((d) => [...d.perCase.keys()]))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const lines = [
    `Per-case composite Δ (${candidate} − ${baseline}, same model; mean over paired replicates, pairs in parentheses):`,
    "",
    `| Case | ${deltas.map((d) => d.model).join(" | ")} |`,
    `|---|${deltas.map(() => "---:").join("|")}|`,
  ];
  for (const c of cases)
    lines.push(
      `| ${c} | ${deltas
        .map((d) => {
          const v = d.perCase.get(c);
          return v ? `${f(v.mean, 1)} (${v.pairs})` : "–";
        })
        .join(" | ")} |`,
    );
  lines.push(`| Mean of cases | ${deltas.map((d) => f(d.delta.mean, 1)).join(" | ")} |`);
  return lines.join("\n");
}

const f = (n: number | undefined, d = 2) => (n === undefined || !Number.isFinite(n) ? "–" : n.toFixed(d));

/** Largest acceptable drop in claim coverage for an accuracy claim. */
export const COVERAGE_GUARD = 0.05;

const arms = (drafts: DraftScore[]) => {
  const g = new Map<string, DraftScore[]>();
  for (const d of drafts) g.set(`${d.model}\u0000${d.system}`, [...(g.get(`${d.model}\u0000${d.system}`) ?? []), d]);
  return [...g.values()].sort((a, b) => (a[0]!.model + a[0]!.system).localeCompare(b[0]!.model + b[0]!.system));
};
const perCase = (ds: DraftScore[], v: (d: DraftScore) => number) => {
  const m = new Map<string, number[]>();
  for (const d of ds) if (Number.isFinite(v(d))) m.set(d.case, [...(m.get(d.case) ?? []), v(d)]);
  return new Map([...m].map(([k, xs]) => [k, mean(xs)]));
};
const meanCost = (ds: DraftScore[]) => {
  const c = ds.map((d) => d.costUsd).filter((x): x is number => x !== undefined);
  return c.length ? mean(c) : undefined;
};

/**
 * Arm `a` minus arm `b` (any models) over the cases both have: per-case means
 * are differenced and bootstrapped over cases.
 */
export function armContrast(a: DraftScore[], b: DraftScore[], v: (d: DraftScore) => number, seed = 1) {
  const pa = perCase(a, v),
    pb = perCase(b, v);
  const diffs = [...pa].filter(([c]) => pb.has(c)).map(([c, x]) => ({ case: c, value: x - pb.get(c)! }));
  return caseClustered(diffs, seed);
}

/**
 * Accuracy-first view: error rate (share of judgments finding ≥1 factual
 * error) per arm with its error classes, and every candidate arm against
 * every baseline arm with the coverage guard and the cost ratio.
 */
export function accuracyMarkdown(drafts: DraftScore[], candidate = "tracetoon-candidate", baseline = "tracetoon-baseline"): string {
  if (!drafts.length) return "";
  const classes = [...ERROR_CLASSES.map(([k]) => k), "other"];
  const lines = [
    "## Accuracy",
    "",
    "Error rate = share of judgments that found at least one factual error (mean of per-case means, 95% bootstrap interval over cases). Error classes are mean factual errors per judgment by kind of statement.",
    "",
    `| Model | System | Drafts | Error rate [95% CI] | Errors | Unsupported | Claims | ${classes.join(" | ")} | $/draft |`,
    `|---|---|---:|---|---:|---:|---:|${classes.map(() => "---:").join("|")}|---:|`,
  ];
  for (const ds of arms(drafts)) {
    const r = caseClustered(ds.map((d) => ({ case: d.case, value: d.errorRate })));
    const m = (v: (d: DraftScore) => number) => caseClustered(ds.map((d) => ({ case: d.case, value: v(d) }))).mean;
    lines.push(
      `| ${ds[0]!.model} | ${ds[0]!.system} | ${ds.length} | ${f(r.mean)} [${f(r.ci[0])}, ${f(r.ci[1])}] | ${f(m((d) => d.factualErrors))} | ${f(m((d) => d.unsupportedClaims))} | ${f(m((d) => d.claims))} | ${classes.map((k) => f(m((d) => d.errorClasses[k] ?? 0))).join(" | ")} | ${f(meanCost(ds), 3)} |`,
    );
  }
  const cands = arms(drafts).filter((ds) => ds[0]!.system === candidate);
  const bases = arms(drafts).filter((ds) => ds[0]!.system === baseline);
  if (cands.length && bases.length) {
    lines.push(
      "",
      `Candidate arms against baseline arms (any model; shared cases). Deltas are candidate minus baseline over per-case means, with a 95% bootstrap interval over cases. Coverage guard: claim coverage may drop by at most ${COVERAGE_GUARD}.`,
      "",
      "| Candidate | Against baseline | Cases | Error rate Δ [95% CI] | Composite Δ [95% CI] | Claims Δ | Guard | Cost ratio |",
      "|---|---|---:|---|---|---:|---|---:|",
    );
    for (const c of cands)
      for (const b of bases) {
        const e = armContrast(c, b, (d) => d.errorRate);
        if (!e.cases) continue;
        const cl = armContrast(c, b, (d) => d.claims);
        const co = armContrast(c, b, (d) => d.composite);
        const cc = meanCost(c),
          bc = meanCost(b);
        lines.push(
          `| ${c[0]!.model} | ${b[0]!.model} | ${e.cases} | ${f(e.mean)} [${f(e.ci[0])}, ${f(e.ci[1])}] | ${f(co.mean, 1)} [${f(co.ci[0], 1)}, ${f(co.ci[1], 1)}] | ${f(cl.mean)} | ${cl.mean >= -COVERAGE_GUARD ? "ok" : "fails"} | ${cc !== undefined && bc !== undefined && cc > 0 && bc > 0 ? (bc >= cc ? `${f(bc / cc, 1)}× cheaper` : `${f(cc / bc, 1)}× costlier`) : "–"} |`,
        );
      }
  }
  return lines.join("\n") + "\n";
}

/** Failed writer attempts for one arm, from `attempts/writer/<key>/<NNN>/failure.json`. */
export interface WriterFailures {
  model: string;
  system: string;
  noDraft: number;
  scope: number;
  timeout: number;
  other: number;
}

/**
 * Failed writer attempts per arm under a run root (or a folder of run roots).
 * "No draft" means the writer finished without a PR or draft; it is retried
 * and reported here as a reliability measure. Failures saved before attempts
 * recorded their arm are skipped.
 */
export function collectWriterFailures(root: string): WriterFailures[] {
  const out = new Map<string, WriterFailures>();
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes("attempts") && existsSync(join(dir, "attempts", "writer")))
      for (const key of readdirSync(join(dir, "attempts", "writer")))
        for (const n of readdirSync(join(dir, "attempts", "writer", key))) {
          const file = join(dir, "attempts", "writer", key, n, "failure.json");
          if (!existsSync(file)) continue;
          const f = JSON.parse(readFileSync(file, "utf8")) as { failureKind?: string; model?: string; system?: string };
          if (!f.model || !f.system) continue;
          const id = `${f.model}\u0000${f.system}`;
          const row = out.get(id) ?? { model: f.model, system: f.system, noDraft: 0, scope: 0, timeout: 0, other: 0 };
          if (f.failureKind === "no-draft") row.noDraft++;
          else if (f.failureKind === "scope") row.scope++;
          else if (f.failureKind === "timeout") row.timeout++;
          else row.other++;
          out.set(id, row);
        }
    if (depth > 0)
      for (const n of names)
        if (!["attempts", "inputs", "derived-reports", "artifacts", "judgments"].includes(n) && statSync(join(dir, n)).isDirectory())
          visit(join(dir, n), depth - 1);
  };
  visit(root, 2);
  return [...out.values()].sort((a, b) => (a.model + a.system).localeCompare(b.model + b.system));
}

/** Failed judge attempts for one judge, from `<judgment>.json.attempts/<key>/<NNN>.result.json`. */
export interface JudgeFailures {
  judge: string;
  timeout: number;
  transient: number;
  format: number;
  other: number;
}

/**
 * Failed judge attempts per judge under a run root (or a folder of run
 * roots). Timed-out and transient calls are retried (up to 3 attempts per
 * order judgment) and a malformed reply gets one format repair; each failed
 * attempt is counted here as a reliability measure. Results saved before
 * they named their judge take the judge from a sibling judgment, else from
 * the judge's folder name.
 */
export function collectJudgeFailures(root: string): JudgeFailures[] {
  const out = new Map<string, JudgeFailures>();
  const count = (judge: string, kind: string) => {
    const row = out.get(judge) ?? { judge, timeout: 0, transient: 0, format: 0, other: 0 };
    if (kind === "timeout") row.timeout++;
    else if (kind === "transient") row.transient++;
    else if (kind === "format") row.format++;
    else row.other++;
    out.set(judge, row);
  };
  const judgeOf = (dir: string): string | undefined => {
    for (const n of readdirSync(dir))
      if (n.endsWith(".json"))
        try {
          const j = JSON.parse(readFileSync(join(dir, n), "utf8")) as { judge?: unknown };
          if (typeof j.judge === "string") return j.judge;
        } catch {
          /* Not a judgment. */
        }
    return undefined;
  };
  const attempts = (dir: string) => {
    for (const key of readdirSync(dir)) {
      if (!statSync(join(dir, key)).isDirectory()) continue;
      for (const n of readdirSync(join(dir, key))) {
        if (!n.endsWith(".result.json")) continue;
        const r = JSON.parse(readFileSync(join(dir, key, n), "utf8")) as {
          failureKind?: string;
          problems?: unknown[];
          judge?: string;
        };
        const kind = r.failureKind ?? (r.problems?.length ? "format" : undefined);
        if (!kind) continue;
        const parent = dirname(dir);
        count(r.judge ?? judgeOf(parent) ?? basename(parent), kind);
      }
    }
  };
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const path = join(dir, n);
      if (!statSync(path).isDirectory()) continue;
      if (n.endsWith(".json.attempts")) attempts(path);
      else if (depth > 0 && !["attempts", "inputs", "derived-reports", "artifacts", "writer"].includes(n)) visit(path, depth - 1);
    }
  };
  visit(root, 12);
  return [...out.values()].sort((a, b) => a.judge.localeCompare(b.judge));
}

export function scoreMarkdown(drafts: DraftScore[], title = "Scores", failures: WriterFailures[] = [],
  judgeFailures: JudgeFailures[] = [],): string {
  const w = WEIGHTS;
  const lines = [
    `## ${title}`,
    "",
    `Composite (0-100) = ${w.claims}·claims + ${w.context}·context + ${w.uncertainties}·uncertainties + ${w.rubric}·rubric (coverage as fractions of the fact sheet, rubric as mean/2) − ${w.factualError}·factual errors − ${w.unsupportedClaim}·unsupported claims − ${w.trap}·traps hit, floored at 0. Each draft is averaged over all its judgments; arm means are means of per-case means, with a 95% bootstrap interval over cases. Components are the primary evidence; the composite is a summary.`,
    "",
    "| Model | System | Drafts | Composite [95% CI] | Claims | Context | Uncert. | Rubric | Errors | Unsupported | Traps | $/draft | Cost covers | Subagents/draft | Input tokens | Queries |",
    "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|",
  ];
  for (const a of armScores(drafts).sort((x, y) => (x.model + x.system).localeCompare(y.model + y.system))) {
    const c = a.components;
    lines.push(
      `| ${a.model} | ${a.system} | ${a.composite.drafts} | ${f(a.composite.mean, 1)} [${f(a.composite.ci[0], 1)}, ${f(a.composite.ci[1], 1)}] | ${f(c.claims)} | ${f(c.context)} | ${f(c.uncertainties)} | ${f(c.rubric)} | ${f(c.factualErrors)} | ${f(c.unsupportedClaims)} | ${f(c.traps)} | ${a.costUsd === undefined ? "–" : `${f(a.costUsd, 3)}${a.costSource === "estimated" ? "*" : ""}`} | ${a.costCovers ?? "–"} | ${f(a.subagentThreads, 1)} | ${a.inputTokens === undefined ? "–" : Math.round(a.inputTokens)} | ${f(a.graphQueries, 1)} |`,
    );
  }
  const deltas = pairedDeltas(drafts);
  if (deltas.length) {
    lines.push(
      "",
      "Paired candidate − other system (same model, case and replicate). Leave one case out = lowest and highest composite Δ when each case in turn is dropped:",
      "",
      "| Model | Against | Pairs | Composite Δ [95% CI] | Leave one case out | Factual errors Δ |",
      "|---|---|---:|---|---|---:|",
    );
    for (const d of deltas)
      lines.push(
        `| ${d.model} | ${d.against} | ${d.delta.drafts} | ${f(d.delta.mean, 1)} [${f(d.delta.ci[0], 1)}, ${f(d.delta.ci[1], 1)}] | ${d.leaveOneOut ? `${f(d.leaveOneOut[0], 1)} to ${f(d.leaveOneOut[1], 1)}` : "–"} | ${f(d.errorsDelta)} |`,
      );
    const perCase = perCaseDeltaMarkdown(drafts);
    if (perCase) lines.push("", perCase);
  }
  if (failures.length) {
    const accepted = (f: WriterFailures) => drafts.filter((d) => d.model === f.model && d.system === f.system).length;
    lines.push(
      "",
      "Writer reliability (failed attempts are retried, up to 3 per draft; scored drafts count accepted attempts):",
      "",
      "| Model | System | Scored drafts | No-draft attempts | Scope-rejected attempts | Timed-out attempts | Other failed attempts |",
      "|---|---|---:|---:|---:|---:|---:|",
      ...failures.map((f) => `| ${f.model} | ${f.system} | ${accepted(f)} | ${f.noDraft} | ${f.scope} | ${f.timeout} | ${f.other} |`),
    );
  }
  if (judgeFailures.length)
    lines.push(
      "",
      "Judge reliability (timed-out and transient calls are retried, up to 3 attempts per order judgment; a malformed reply gets one format repair):",
      "",
      "| Judge | Failed attempts | Timed out | Transient | Format | Other |",
      "|---|---:|---:|---:|---:|---:|",
      ...judgeFailures.map((f) => `| ${f.judge} | ${f.timeout + f.transient + f.format + f.other} | ${f.timeout} | ${f.transient} | ${f.format} | ${f.other} |`),
    );
  if (drafts.length) lines.push("", accuracyMarkdown(drafts).trimEnd());
  if (drafts.some((d) => d.costSource === "estimated"))
    lines.push("", `\\* Estimated from token counts and src/report/prices.json (${PRICE_TABLE_NOTE}).`);
  if (drafts.some((d) => d.usageScope))
    lines.push(
      "",
      "Cost covers: \"all threads\" includes every subagent thread the writer spawned (researcher, drafter, reviewer…), from the artifact or, for runs saved before that was recorded, recomputed from the accepted attempt's saved Codex traces (\"traces\"), with each model response counted once. \"Main thread only\" omits subagents and understates cost when the skill delegates. $/draft in the accuracy table and its cost ratios use the same figures.",
    );
  return lines.join("\n") + "\n";
}

const PRICE_TABLE_NOTE = (PRICES as unknown as { note?: string }).note ?? "list prices";
