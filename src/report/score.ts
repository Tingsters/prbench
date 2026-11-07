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
import { join, relative, sep } from "node:path";
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
  outputTokens?: number;
  graphQueries?: number;
}

interface SavedJudgment {
  rubricVersion?: string;
  judge: string;
  case: string;
  labels: { A: string; B: string };
  judgment?: { A: SideJudgment; B: SideJudgment };
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
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
  type Acc = { key: Omit<DraftScore, keyof Components | "composite" | "judgments" | "judges">; comps: Components[]; judges: Set<string>; artifactDir?: string };
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
            judges: new Set(),
            artifactDir: join(modelDir, "artifacts", j.case),
          };
          acc.set(id, a);
        }
        a.comps.push(sideComponents(j.judgment[side], facts));
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
    };
    const artifact = a.artifactDir && join(a.artifactDir, `${a.key.system}.json`);
    if (artifact && existsSync(artifact)) {
      const meta = JSON.parse(readFileSync(artifact, "utf8")).meta ?? {};
      d.inputTokens = meta.inputTokens;
      d.outputTokens = meta.outputTokens;
      d.graphQueries = meta.operationCounts?.["graph.queries"];
      if (typeof meta.costUsd === "number") {
        d.costUsd = meta.costUsd;
        d.costSource = "reported";
      } else {
        const est = estimateCost(String(meta.model ?? a.key.model), meta);
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
    };
  });
}

/** Candidate minus another system, paired by model, case and replicate, clustered by case. */
export function pairedDeltas(drafts: DraftScore[], candidate = "tracetoon-candidate") {
  const out: { model: string; against: string; delta: ReturnType<typeof caseClustered>; errorsDelta: number }[] = [];
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
      if (rows.length)
        out.push({
          model,
          against,
          delta: caseClustered(rows),
          errorsDelta: caseClustered(rows.map((r) => ({ case: r.case, value: r.err }))).mean,
        });
    }
  return out;
}

const f = (n: number | undefined, d = 2) => (n === undefined || !Number.isFinite(n) ? "–" : n.toFixed(d));

/** Failed writer attempts for one arm, from `attempts/writer/<key>/<NNN>/failure.json`. */
export interface WriterFailures {
  model: string;
  system: string;
  noDraft: number;
  scope: number;
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
          const row = out.get(id) ?? { model: f.model, system: f.system, noDraft: 0, scope: 0, other: 0 };
          if (f.failureKind === "no-draft") row.noDraft++;
          else if (f.failureKind === "scope") row.scope++;
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

export function scoreMarkdown(drafts: DraftScore[], title = "Scores", failures: WriterFailures[] = []): string {
  const w = WEIGHTS;
  const lines = [
    `## ${title}`,
    "",
    `Composite (0-100) = ${w.claims}·claims + ${w.context}·context + ${w.uncertainties}·uncertainties + ${w.rubric}·rubric (coverage as fractions of the fact sheet, rubric as mean/2) − ${w.factualError}·factual errors − ${w.unsupportedClaim}·unsupported claims − ${w.trap}·traps hit, floored at 0. Each draft is averaged over all its judgments; arm means are means of per-case means, with a 95% bootstrap interval over cases. Components are the primary evidence; the composite is a summary.`,
    "",
    "| Model | System | Drafts | Composite [95% CI] | Claims | Context | Uncert. | Rubric | Errors | Unsupported | Traps | $/draft | Input tokens | Queries |",
    "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const a of armScores(drafts).sort((x, y) => (x.model + x.system).localeCompare(y.model + y.system))) {
    const c = a.components;
    lines.push(
      `| ${a.model} | ${a.system} | ${a.composite.drafts} | ${f(a.composite.mean, 1)} [${f(a.composite.ci[0], 1)}, ${f(a.composite.ci[1], 1)}] | ${f(c.claims)} | ${f(c.context)} | ${f(c.uncertainties)} | ${f(c.rubric)} | ${f(c.factualErrors)} | ${f(c.unsupportedClaims)} | ${f(c.traps)} | ${a.costUsd === undefined ? "–" : `${f(a.costUsd, 3)}${a.costSource === "estimated" ? "*" : ""}`} | ${a.inputTokens === undefined ? "–" : Math.round(a.inputTokens)} | ${f(a.graphQueries, 1)} |`,
    );
  }
  const deltas = pairedDeltas(drafts);
  if (deltas.length) {
    lines.push(
      "",
      "Paired candidate − other system (same model, case and replicate):",
      "",
      "| Model | Against | Pairs | Composite Δ [95% CI] | Factual errors Δ |",
      "|---|---|---:|---|---:|",
    );
    for (const d of deltas)
      lines.push(
        `| ${d.model} | ${d.against} | ${d.delta.drafts} | ${f(d.delta.mean, 1)} [${f(d.delta.ci[0], 1)}, ${f(d.delta.ci[1], 1)}] | ${f(d.errorsDelta)} |`,
      );
  }
  if (failures.length) {
    const accepted = (f: WriterFailures) => drafts.filter((d) => d.model === f.model && d.system === f.system).length;
    lines.push(
      "",
      "Writer reliability (failed attempts are retried, up to 3 per draft; scored drafts count accepted attempts):",
      "",
      "| Model | System | Scored drafts | No-draft attempts | Scope-rejected attempts | Other failed attempts |",
      "|---|---|---:|---:|---:|---:|",
      ...failures.map((f) => `| ${f.model} | ${f.system} | ${accepted(f)} | ${f.noDraft} | ${f.scope} | ${f.other} |`),
    );
  }
  if (drafts.some((d) => d.costSource === "estimated"))
    lines.push("", `\\* Estimated from token counts and src/report/prices.json (${PRICE_TABLE_NOTE}).`);
  return lines.join("\n") + "\n";
}

const PRICE_TABLE_NOTE = (PRICES as unknown as { note?: string }).note ?? "list prices";
