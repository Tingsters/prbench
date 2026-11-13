import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SideJudgment } from "../src/judge/rubric.ts";
import { consensusOutcome, loadRun, pairedDelta, pairedDeltaMarkdown } from "../scripts/paired-delta.ts";
import type { PairResult } from "../src/judge/pairwise.ts";
import { composite, sideComponents } from "../src/report/score.ts";
import { cleanupTemps, tempDir } from "./helpers.ts";

afterAll(cleanupTemps);

const B = "tracetoon-baseline",
  C = "tracetoon-candidate",
  JUDGES = ["j1", "j2"];
const facts = { claims: ["c1", "c2"], context: [], uncertainties: [] };
const side = (claims: number, errors = 0): SideJudgment => ({
  factualErrors: Array.from({ length: errors }, (_, i) => `e${i}`),
  unsupportedClaims: [],
  claimAssessments: [],
  claimsCovered: ["C1", "C2"].slice(0, claims),
  contextCovered: [],
  uncertaintiesRespected: [],
  trapsHit: [],
  rubric: {} as SideJudgment["rubric"],
  notes: "",
});
const pair = (c: string, judge: string, verdict: string): PairResult => ({
  rubricVersion: 6,
  case: c,
  split: "dev",
  judge,
  x: B,
  y: C,
  verdict,
  flipped: false,
  sides: {},
  warnings: [],
});

/**
 * A one-model compare layout: per replicate, `pairs.json` verdicts and one
 * judgment per case scoring baseline and candidate claims coverage.
 */
function run(rows: { case: string; replicate: number; verdicts: [string, string]; base: number; cand: number; candErrors?: number }[]) {
  const root = tempDir();
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(v));
  };
  write("manifest.json", { settings: { models: ["m"], judges: JUDGES, replicates: 2 } });
  for (const rep of [1, 2]) {
    const dir = rep === 1 ? "m" : "replicate-002/m";
    const mine = rows.filter((r) => r.replicate === rep);
    write(`${dir}/${B}/pairs.json`, mine.flatMap((r) => JUDGES.map((j, i) => pair(r.case, j, r.verdicts[i]!))));
    for (const r of mine)
      write(`${dir}/${B}/judgments/v6/${r.case}/j1/b__c__ab.json`, {
        rubricVersion: "6",
        judge: "j1",
        case: r.case,
        labels: { A: B, B: C },
        judgment: { A: side(r.base), B: side(r.cand, r.candErrors) },
      });
  }
  return loadRun(root, () => facts);
}

test("consensus needs every judge to agree", () => {
  expect(consensusOutcome([pair("x", "j1", C), pair("x", "j2", C)], JUDGES)).toBe(1);
  expect(consensusOutcome([pair("x", "j1", B), pair("x", "j2", B)], JUDGES)).toBe(-1);
  expect(consensusOutcome([pair("x", "j1", C), pair("x", "j2", "tie")], JUDGES)).toBe(0);
  expect(consensusOutcome([pair("x", "j1", C), pair("x", "j2", B)], JUDGES)).toBe(0);
  // A missing judge gives no consensus.
  expect(consensusOutcome([pair("x", "j1", C)], JUDGES)).toBe(0);
});

test("compares two runs pair by pair against their own baselines", () => {
  // Without a rubric, covering one more of two claims adds D composite points; one factual error costs 15.
  const a = run([
    { case: "p1", replicate: 1, verdicts: [C, C], base: 1, cand: 2 }, // Δ +D
    { case: "p1", replicate: 2, verdicts: [C, "tie"], base: 1, cand: 2 }, // Δ +D
    { case: "p2", replicate: 1, verdicts: [B, B], base: 2, cand: 1 }, // Δ −D
    { case: "p2", replicate: 2, verdicts: [C, C], base: 2, cand: 2 }, // Δ 0
  ]);
  const b = run([
    { case: "p1", replicate: 1, verdicts: [C, "tie"], base: 1, cand: 1 }, // Δ 0
    { case: "p1", replicate: 2, verdicts: [C, C], base: 1, cand: 2, candErrors: 1 }, // Δ D − 15
    { case: "p2", replicate: 1, verdicts: [B, B], base: 2, cand: 1 }, // Δ −D
    { case: "p2", replicate: 2, verdicts: [B, B], base: 2, cand: 2 }, // Δ 0
  ]);
  const r = pairedDelta(a, b);
  expect(r.pairs).toBe(4);
  // p1 r1: A +1 vs B 0 → A; p1 r2: 0 vs +1 → B; p2 r1: equal; p2 r2: +1 vs −1 → A.
  expect([r.aBetter, r.bBetter, r.equal]).toEqual([2, 1, 1]);
  expect(r.consensus.a).toEqual([2, 1, 1]);
  expect(r.consensus.b).toEqual([1, 1, 2]);
  // Per-case Δ-of-Δ: p1 = mean(D − 0, D − (D − 15)) = (D + 15) / 2; p2 = mean(0, 0) = 0.
  const D = composite(sideComponents(side(2), facts)) - composite(sideComponents(side(1), facts));
  expect(r.perCase.map((c) => c.case)).toEqual(["p1", "p2"]);
  expect(r.perCase[0]!.deltaOfDelta).toBeCloseTo((D + 15) / 2, 9);
  expect(r.perCase[1]!.deltaOfDelta).toBe(0);
  expect(r.deltaOfDelta.mean).toBeCloseTo((D + 15) / 4, 9);
  expect(r.deltaOfDelta.ci[0]).toBeLessThanOrEqual(r.deltaOfDelta.mean);
  expect(r.deltaOfDelta.ci[1]).toBeGreaterThanOrEqual(r.deltaOfDelta.mean);
  // Deterministic: the same inputs give the same interval.
  expect(pairedDelta(a, b).deltaOfDelta.ci).toEqual(r.deltaOfDelta.ci);
  expect(r.factualErrors.bCandidate).toBeCloseTo(0.25, 9);
  expect(r.factualErrors.aCandidate).toBe(0);
  const md = pairedDeltaMarkdown(r);
  expect(md).toContain(`| 4 | 2 | 1 | 1 | 2/1/1 | 1/1/2 | +${((D + 15) / 4).toFixed(1)} [`);
  expect(md).toContain(`| p1 | 2 | 1 | 1 | 0 | +${((D + 15) / 2).toFixed(1)} |`);
});
