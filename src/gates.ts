import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stageKey } from "./run/cache.ts";
import type { AdjudicationSource } from "./run/adjudication.ts";
import type { PairResult } from "./judge/pairwise.ts";
import type { Report } from "./report.ts";
import type { PRArtifact } from "./schema/artifact.ts";
import { artifactDigest } from "./schema/artifact.ts";
import type { WriterMetric } from "./performance.ts";

/** Keep every adoption criterion inside the frozen policy dependency closure. */
export function adoptionGate(input: {
  complete: boolean;
  purpose: string;
  quality: string;
  performance: string;
  policyCurrent: boolean;
  pendingCleanup: number;
  writers: WriterMetric[];
}) {
  const candidates = input.writers.filter(
    (m) => m.system === "tracetoon-candidate",
  );
  const workflowGaps = candidates
    .filter((m) => {
      const workflow = m.workflow as PRArtifact["meta"]["workflow"];
      return (
        workflow?.declaredIndependentRoles !== 3 ||
        !workflow.reviewCurrent ||
        workflow.reviewVersion !== 2
      );
    })
    .map(
      (m) =>
        `${m.model}/${m.case}/r${m.replicate}: three independent roles and a current v2 review are required`,
    );
  if (!candidates.length)
    workflowGaps.push("Candidate workflow records are unavailable");
  const failed = input.quality === "failed" || input.performance === "failed";
  const inconclusive =
    !input.policyCurrent ||
    input.purpose !== "confirmation" ||
    input.quality !== "passed" ||
    input.performance !== "passed" ||
    input.pendingCleanup > 0 ||
    workflowGaps.length > 0;
  const status = !input.complete
    ? "incomplete"
    : failed
      ? "failed"
      : inconclusive
        ? "inconclusive"
        : "passed";
  return {
    passed: status === "passed",
    status,
    workflowGaps,
    policyCurrent: input.policyCurrent,
    exitCode:
      status === "incomplete"
        ? 2
        : status === "failed"
          ? 1
          : status === "inconclusive"
            ? 3
            : 0,
  };
}

export interface ComparisonReport {
  model: string;
  replicate: number;
  comparison: string;
  report: Report;
}
export interface AccuracyFinding {
  id: string;
  model: string;
  replicate: number;
  case: string;
  artifactDigest: string;
  claim: string;
  statuses: string[];
  observations: { judge: string; evidenceRefs: string[]; reason: string }[];
}
export function accuracyFindings(
  pairs: { model: string; replicate: number; pair: PairResult }[],
  artifacts: Map<string, PRArtifact>,
): AccuracyFinding[] {
  const all = new Map<string, AccuracyFinding>();
  for (const { model, replicate, pair } of pairs) {
    const artifact = artifacts.get(
      `${replicate}/${model}/${pair.case}/tracetoon-candidate`,
    );
    if (!artifact)
      throw new Error("Accuracy gate is missing its candidate artifact.");
    const sha = artifactDigest(artifact);
    for (const side of pair.sides["tracetoon-candidate"] ?? [])
      for (const assessment of side.claimAssessments) {
        if (!["contradicted", "unsupported"].includes(assessment.status))
          continue;
        const id = stageKey("accuracy-finding", {
          model,
          replicate,
          case: pair.case,
          artifact: sha,
          claim: assessment.claim,
        });
        const finding = all.get(id) ?? {
          id,
          model,
          replicate,
          case: pair.case,
          artifactDigest: sha,
          claim: assessment.claim,
          statuses: [],
          observations: [],
        };
        if (!finding.statuses.includes(assessment.status))
          finding.statuses.push(assessment.status);
        finding.observations.push({
          judge: pair.judge,
          evidenceRefs: assessment.evidenceRefs,
          reason: assessment.reason,
        });
        all.set(id, finding);
      }
  }
  return [...all.values()];
}
export interface Adjudication {
  finding: string;
  outcome: "confirmed" | "false-positive" | "unresolved";
  reviewedBy: string;
  reviewedAt: string;
  rationale: string;
  sources: AdjudicationSource[];
}
export function qualityGate(
  reports: ComparisonReport[],
  split: string,
  models: string[],
  findings: AccuracyFinding[],
  adjudications: Adjudication[] = [],
  /** The provider's no-Tracetoon writer (`codex-native`, `claude-native`). */
  native = "codex-native",
) {
  const failures: string[] = [],
    unresolved: string[] = [];
  for (const finding of findings) {
    const audit = adjudications.find((a) => a.finding === finding.id);
    if (!audit || audit.outcome === "unresolved") unresolved.push(finding.id);
    else if (audit.outcome === "confirmed")
      failures.push(
        `${finding.model}/${finding.case}/r${finding.replicate}: ${finding.claim}`,
      );
  }
  let improved = false,
    totalWins = 0,
    totalLosses = 0;
  for (const model of models) {
    const selected = reports.filter(
      (r) => r.model === model && r.comparison === "tracetoon-baseline",
    );
    const avg = (system: string, key: "claimCoverage" | "contextCoverage") => {
      const values = selected
        .map(
          (r) =>
            r.report.splits[split]?.systems.find((s) => s.system === system)?.[
              key
            ],
        )
        .filter((v): v is number => v !== undefined && Number.isFinite(v));
      return values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : null;
    };
    for (const key of ["claimCoverage", "contextCoverage"] as const) {
      const b = avg("tracetoon-baseline", key),
        c = avg("tracetoon-candidate", key);
      if (b === null || c === null) {
        unresolved.push(`${model}: ${key} unavailable`);
        continue;
      }
      if (c + 1e-9 < b)
        failures.push(`${model}: ${key} regressed against baseline`);
      if (c > b + 1e-9) improved = true;
    }
    // Consensus rows have a stable public shape; no individual judge vote can hide a flagged claim.
    for (const comparison of ["tracetoon-baseline", native]) {
      let wins = 0,
        losses = 0;
      for (const report of reports.filter(
        (r) => r.model === model && r.comparison === comparison,
      )) {
        const summary = report.report.splits[split]?.pairs.find(
          (h) => h.judge === "all judges agree",
        );
        if (summary) {
          wins += summary.yWins;
          losses += summary.xWins;
        }
      }
      if (wins < losses)
        failures.push(
          `${model}: consensus losses exceed wins against ${comparison}`,
        );
      if (comparison === "tracetoon-baseline") {
        totalWins += wins;
        totalLosses += losses;
      }
    }
  }
  if (!improved)
    failures.push(
      "No measured claim/context coverage improvement against baseline",
    );
  if (totalWins <= totalLosses)
    failures.push(
      "Aggregate consensus wins must exceed losses against baseline",
    );
  return {
    passed: !failures.length && !unresolved.length,
    status: failures.length
      ? "failed"
      : unresolved.length
        ? "inconclusive"
        : "passed",
    failures,
    unresolvedAccuracy: unresolved,
    consensusWins: totalWins,
    consensusLosses: totalLosses,
    note: "Raw judgments remain unchanged. Source adjudication is a separate audit; unresolved accuracy flags cannot pass.",
  };
}
