import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SideJudgment } from "../src/judge/rubric.ts";
import { failureKind } from "../src/run/ledger.ts";
import {
  caseClustered,
  collectDraftScores,
  collectJudgeFailures,
  collectWriterFailures,
  accuracyMarkdown,
  errorClass,
  composite,
  estimateCost,
  leaveOneCaseOut,
  pairedDeltas,
  perCaseDeltaMarkdown,
  scoreMarkdown,
  sideComponents,
} from "../src/report/score.ts";
import { cleanupTemps, tempDir } from "./helpers.ts";

afterAll(cleanupTemps);

const facts = {
  claims: ["c1", "c2", "c3", "c4"],
  context: ["x1", "x2"],
  uncertainties: ["u1"],
};
const side = (over: Partial<SideJudgment> = {}): SideJudgment => ({
  factualErrors: [],
  unsupportedClaims: [],
  claimAssessments: [],
  claimsCovered: ["C1", "C2"],
  contextCovered: ["X1"],
  uncertaintiesRespected: ["U1"],
  trapsHit: [],
  rubric: {
    problem: 2,
    rationale: 1,
    validation: 2,
    consequences: 1,
    orientation: 2,
    entry: 2,
    economy: 2,
    feedback: null,
    links: null,
    scope: 0,
  },
  notes: "",
  ...over,
});

test("components are fractions of the fact sheet and the rubric over applicable items", () => {
  const c = sideComponents(side(), facts);
  expect(c).toEqual({
    claims: 0.5,
    context: 0.5,
    uncertainties: 1,
    rubric: 12 / 8 / 2,
    factualErrors: 0,
    unsupportedClaims: 0,
    traps: 0,
  });
  // 35·.5 + 15·.5 + 15·1 + 35·.75 = 66.25
  expect(composite(c)).toBeCloseTo(66.25, 6);
});

test("mistakes subtract and the composite never goes below zero", () => {
  const one = sideComponents(side({ factualErrors: ["e"], unsupportedClaims: ["u"] }), facts);
  expect(composite(one)).toBeCloseTo(66.25 - 15 - 7, 6);
  const many = sideComponents(side({ factualErrors: ["a", "b", "c", "d", "e"] }), facts);
  expect(composite(many)).toBe(0);
});

test("cost is estimated from tokens, with cached input at its own rate", () => {
  const table = { m: { input: 1, cachedInput: 0.1, output: 10 } };
  expect(estimateCost("m", { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 10_000 }, table)).toBeCloseTo(0.4 + 0.06 + 0.1, 9);
  expect(estimateCost("unknown", { inputTokens: 1 }, table)).toBeUndefined();
});

test("arm means weight cases equally and the interval is reproducible", () => {
  const rows = [
    { case: "a", value: 10 },
    { case: "a", value: 30 },
    { case: "b", value: 50 },
    { case: "c", value: 70 },
  ];
  const r = caseClustered(rows);
  expect(r.mean).toBeCloseTo((20 + 50 + 70) / 3, 9);
  expect(r.cases).toBe(3);
  expect(caseClustered(rows).ci).toEqual(r.ci);
});

test("collects drafts from a compare layout, averaging every judgment of a draft", () => {
  const root = tempDir();
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(v));
  };
  const judgment = (order: string, a: SideJudgment, b: SideJudgment, labels = { A: "tracetoon-baseline", B: "tracetoon-candidate" }) => ({
    rubricVersion: "6",
    judge: "codex:j@medium",
    case: "one",
    order,
    labels,
    judgment: { A: a, B: b, preferred: "tie" },
  });
  write("luna/tracetoon-baseline/judgments/v6/one/j/b__c__ab.json", judgment("ab", side({ factualErrors: ["e"] }), side()));
  write("luna/tracetoon-baseline/judgments/v6/one/j/b__c__ba.json", judgment("ba", side({ factualErrors: ["e"] }), side(), { A: "tracetoon-candidate", B: "tracetoon-baseline" }));
  write("replicate-002/luna/tracetoon-baseline/judgments/v6/one/j/b__c__ab.json", judgment("ab", side(), side()));
  // Raw attempts are never scored.
  write("attempts/luna/tracetoon-baseline/judgments/v6/one/j/x.json", judgment("ab", side(), side()));
  // Judge attempt folders hold a byte copy of each final judgment; it is counted once.
  write(
    "luna/tracetoon-baseline/judgments/v6/one/j/b__c__ab.json.attempts/k/001.accepted.json",
    judgment("ab", side({ factualErrors: ["e"] }), side()),
  );
  write("luna/artifacts/one/tracetoon-candidate.json", {
    meta: { model: "gpt-6-luna", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, operationCounts: { "graph.queries": 3 } },
  });
  const drafts = collectDraftScores(root, (id) => (id === "one" ? facts : undefined));
  expect(drafts.map((d) => [d.model, d.replicate, d.system, d.judgments])).toEqual([
    ["luna", 1, "tracetoon-baseline", 2],
    ["luna", 2, "tracetoon-baseline", 1],
    ["luna", 1, "tracetoon-candidate", 2],
    ["luna", 2, "tracetoon-candidate", 1],
  ]);
  const cand = drafts.find((d) => d.system === "tracetoon-candidate" && d.replicate === 1)!;
  expect(cand.factualErrors).toBe(0.5);
  expect(cand.composite).toBeCloseTo(66.25 - 7.5, 6);
  expect(cand.graphQueries).toBe(3);
  expect(cand.costSource).toBe("estimated");
  expect(cand.costUsd).toBeCloseTo(0.1, 9);
  const md = scoreMarkdown(drafts);
  expect(md).toContain("| luna | tracetoon-candidate | 2 |");
  expect(md).toContain("Paired candidate − other system");
});

test("a writer that leaves no draft is its own retryable kind, counted per arm", () => {
  expect(failureKind(new Error("tracetoon-baseline produced no PR draft (exit 0)"))).toBe("no-draft");
  expect(failureKind(new Error("codex-native produced no PR (exit 0)"))).toBe("no-draft");
  expect(failureKind(new Error("Host agent state or outside case inputs were accessed: V26. Preserved artifact rejected."))).toBe("scope");
  const root = tempDir();
  const fail = (key: string, n: string, v: unknown) => {
    mkdirSync(join(root, "codex", "attempts", "writer", key, n), { recursive: true });
    writeFileSync(join(root, "codex", "attempts", "writer", key, n, "failure.json"), JSON.stringify(v));
  };
  fail("k1", "001", { failureKind: "no-draft", model: "luna@low", system: "tracetoon-baseline" });
  fail("k1", "002", { failureKind: "invalid", model: "luna@low", system: "tracetoon-baseline" });
  fail("k2", "001", { failureKind: "no-draft", model: "luna@low", system: "tracetoon-baseline" });
  fail("k2", "002", { failureKind: "scope", model: "luna@low", system: "tracetoon-baseline" });
  fail("k2", "003", { failureKind: "timeout", model: "luna@low", system: "tracetoon-baseline" });
  fail("k3", "001", { failureKind: "no-draft" }); // saved before failures named their arm
  expect(collectWriterFailures(root)).toEqual([
    { model: "luna@low", system: "tracetoon-baseline", noDraft: 2, scope: 1, timeout: 1, other: 1 },
  ]);
  expect(scoreMarkdown([], "S", collectWriterFailures(root))).toContain("| luna@low | tracetoon-baseline | 0 | 2 | 1 | 1 | 1 |");
});

test("judge failures are counted per judge in the reliability section", () => {
  const root = tempDir();
  const dir = join(root, "claude", "replicate-003", "m@medium", "tracetoon-baseline", "judgments", "v6", "pr5", "claude_x_medium");
  const attempt = (order: string, n: string, v: unknown) => {
    mkdirSync(join(dir, `x__y__${order}.json.attempts`, "k"), { recursive: true });
    writeFileSync(join(dir, `x__y__${order}.json.attempts`, "k", `${n}.result.json`), JSON.stringify(v));
  };
  attempt("ab", "001", { problems: ["bad ref"], text: "{}" });
  attempt("ab", "002", { problems: [], text: "{}" }); // accepted repair: not a failure
  writeFileSync(join(dir, "x__y__ab.json"), JSON.stringify({ judge: "claude:x@medium" }));
  attempt("ba", "001", { error: "claude judge timed out after 900000 ms", failureKind: "timeout" }); // legacy: no judge field
  attempt("ba", "002", { error: "503", failureKind: "transient", judge: "claude:x@medium" });
  expect(collectJudgeFailures(root)).toEqual([{ judge: "claude:x@medium", timeout: 1, transient: 1, format: 1, other: 0 }]);
  const md = scoreMarkdown([], "S", [], collectJudgeFailures(root));
  expect(md).toContain("Judge reliability");
  expect(md).toContain("| claude:x@medium | 3 | 1 | 1 | 1 | 0 |");
  expect(scoreMarkdown([], "S")).not.toContain("Judge reliability");
});

test("accuracy view: error rate, error classes, and candidate against any baseline arm", () => {
  expect(errorClass("`bun test`: 60 pass, ran on the final code")).toBe("validation");
  expect(errorClass("adds fallback branches in belongs")).toBe("code structure");
  expect(errorClass("Renames the module")).toBe("other");
  const root = tempDir();
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(v));
  };
  const j = (model: string, err: string[], k: string) =>
    write(`${model}/tracetoon-baseline/judgments/v6/one/j/${k}.json`, {
      rubricVersion: "6",
      judge: "codex:j@medium",
      case: "one",
      order: "ab",
      labels: { A: "tracetoon-baseline", B: "tracetoon-candidate" },
      judgment: { A: side({ factualErrors: err }), B: side(), preferred: "tie" },
    });
  j("luna", ["`bun test` 60 pass"], "x");
  j("luna", [], "y");
  j("sol", [], "x");
  const drafts = collectDraftScores(root, () => facts);
  const lunaBase = drafts.find((d) => d.model === "luna" && d.system === "tracetoon-baseline")!;
  expect(lunaBase.errorRate).toBe(0.5);
  expect(lunaBase.errorClasses).toEqual({ validation: 0.5 });
  const md = accuracyMarkdown(drafts);
  expect(md).toContain("| luna | tracetoon-baseline | 1 | 0.50");
  // Luna's candidate (0 errors) against Luna's baseline (0.5) and Sol's (0).
  expect(md).toContain("| luna | luna | 1 | -0.50");
  expect(md).toContain("| luna | sol | 1 | 0.00");
  // Composite Δ: Luna's baseline lost 15 points on one of two judgments; one case has no interval.
  expect(md).toContain("| luna | luna | 1 | -0.50 [–, –] | 7.5 [–, –] |");
  expect(md).toContain("| luna | sol | 1 | 0.00 [–, –] | 0.0 [–, –] |");
});

test("cross-model composite Δ is clustered by case, with a reproducible interval", () => {
  const root = tempDir();
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(v));
  };
  // Baseline-only runs (no native drafts): candidate errs on case "two" in one of two replicates.
  const j = (model: string, rep: number, c: string, candErrors: string[]) =>
    write(`${rep === 1 ? "" : `replicate-00${rep}/`}${model}/tracetoon-baseline/judgments/v6/${c}/j/ab.json`, {
      rubricVersion: "6",
      judge: "codex:j@medium",
      case: c,
      order: "ab",
      labels: { A: "tracetoon-baseline", B: "tracetoon-candidate" },
      judgment: { A: side({ factualErrors: ["e"] }), B: side({ factualErrors: candErrors }), preferred: "tie" },
    });
  for (const model of ["luna", "sol"])
    for (const rep of [1, 2])
      for (const c of ["one", "two", "three"]) j(model, rep, c, c === "two" && rep === 1 ? ["e"] : []);
  const drafts = collectDraftScores(root, () => facts);
  expect(new Set(drafts.map((d) => d.system))).toEqual(new Set(["tracetoon-baseline", "tracetoon-candidate"]));
  const md = accuracyMarkdown(drafts);
  expect(md).toContain("Composite Δ [95% CI]");
  // Per-case candidate − baseline composite: 15, 7.5, 15 → mean 12.5; bootstrap over the three cases.
  const row = md.split("\n").find((l) => l.startsWith("| luna | sol | 3 |"))!;
  const m = row.match(/\| (-?[\d.]+) \[(-?[\d.]+), (-?[\d.]+)\] \| [-\d.]+ \| (ok|fails) \|/)!;
  expect(Number(m[1])).toBeCloseTo(12.5, 1);
  expect(Number(m[2])).toBeGreaterThanOrEqual(7.5);
  expect(Number(m[3])).toBeLessThanOrEqual(15);
  expect(Number(m[2])).toBeLessThan(Number(m[3]));
  expect(accuracyMarkdown(drafts)).toBe(md);
  // The paired table shows only the baseline row when a run has no native drafts.
  const score = scoreMarkdown(drafts);
  const paired = score.split("Paired candidate − other system")[1]!.split("\n\n")[1]!;
  expect(paired).toContain("| luna | tracetoon-baseline | 6 |");
  expect(paired).toContain("| sol | tracetoon-baseline | 6 |");
  expect(paired).not.toContain("native");
});

test("robustness: per-case composite Δ per model and a leave-one-case-out range", () => {
  const root = tempDir();
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(v));
  };
  // Candidate loses 15 points (one factual error) on the listed cases only.
  const j = (model: string, c: string, candErrors: string[]) =>
    write(`${model}/tracetoon-baseline/judgments/v6/${c}/j/ab.json`, {
      rubricVersion: "6",
      judge: "codex:j@medium",
      case: c,
      order: "ab",
      labels: { A: "tracetoon-baseline", B: "tracetoon-candidate" },
      judgment: { A: side(), B: side({ factualErrors: candErrors }), preferred: "tie" },
    });
  for (const c of ["pr1", "pr2", "pr10"]) j("luna", c, c === "pr2" ? ["e"] : []);
  for (const c of ["pr1", "pr2"]) j("sol", c, ["e"]);
  const drafts = collectDraftScores(root, () => facts);
  expect(leaveOneCaseOut([{ case: "a", value: 1 }])).toBeUndefined();
  expect(leaveOneCaseOut([
    { case: "a", value: 0 },
    { case: "b", value: -15 },
    { case: "c", value: 0 },
  ])).toEqual([-7.5, 0]);
  const deltas = pairedDeltas(drafts);
  const luna = deltas.find((d) => d.model === "luna")!;
  expect([...luna.perCase]).toEqual([
    ["pr1", { mean: 0, pairs: 1 }],
    ["pr10", { mean: 0, pairs: 1 }],
    ["pr2", { mean: -15, pairs: 1 }],
  ]);
  expect(luna.delta.mean).toBeCloseTo(-5, 9);
  expect(luna.leaveOneOut).toEqual([-7.5, 0]);
  const md = scoreMarkdown(drafts);
  expect(md).toContain("| luna | tracetoon-baseline | 3 | -5.0 [");
  expect(md).toContain("] | -7.5 to 0.0 | 0.33 |");
  expect(md).toContain("| sol | tracetoon-baseline | 2 | -15.0 [");
  const table = perCaseDeltaMarkdown(drafts);
  expect(table).toContain("| Case | luna | sol |");
  // Cases sort numerically; a model without a case shows a dash.
  expect(table.split("\n").filter((l) => /^\| pr/.test(l))).toEqual([
    "| pr1 | 0.0 (1) | -15.0 (1) |",
    "| pr2 | -15.0 (1) | -15.0 (1) |",
    "| pr10 | 0.0 (1) | – |",
  ]);
  expect(table).toContain("| Mean of cases | -5.0 | -15.0 |");
});
