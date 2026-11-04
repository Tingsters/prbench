import { bootstrapMeanCI, mean } from "./stats.ts";
import {
  compareValidationWork,
  type ValidationWork,
} from "./validationWork.ts";
export interface WriterMetric extends ValidationWork {
  model: string;
  case: string;
  system: string;
  replicate: number;
  stageTimings?: Record<string, number>;
  inputTokens?: number;
  cleanup?: string;
  writerOutcome?: { isError?: boolean };
  [field: string]: unknown;
}
export const median = (xs: number[]) => {
  const values = xs.filter(Number.isFinite).sort((a, b) => a - b),
    mid = Math.floor(values.length / 2);
  return !values.length
    ? null
    : values.length % 2
      ? values[mid]!
      : (values[mid - 1]! + values[mid]!) / 2;
};
export function performanceReport(
  rows: WriterMetric[],
  expectedPairs: number,
  requireWorkEvidence = false,
) {
  const pairs: {
    case: string;
    model: string;
    replicate: number;
    baselineMs: number;
    candidateMs: number;
    baselineTokens?: number;
    candidateTokens?: number;
  }[] = [];
  const validationComparability = rows
    .filter((r) => r.system === "tracetoon-candidate")
    .map((candidate) => ({
      case: candidate.case,
      model: candidate.model,
      replicate: candidate.replicate,
      ...compareValidationWork(
        rows.find(
          (r) =>
            r.case === candidate.case &&
            r.model === candidate.model &&
            r.replicate === candidate.replicate &&
            r.system === "tracetoon-baseline",
        ),
        candidate,
      ),
    }));
  for (const candidate of rows.filter(
    (r) => r.system === "tracetoon-candidate",
  )) {
    const baseline = rows.find(
      (r) =>
        r.case === candidate.case &&
        r.model === candidate.model &&
        r.replicate === candidate.replicate &&
        r.system === "tracetoon-baseline",
    );
    const b = baseline?.stageTimings?.writerMs,
      c = candidate.stageTimings?.writerMs;
    if (b && c && b > 0 && c > 0)
      pairs.push({
        case: candidate.case,
        model: candidate.model,
        replicate: candidate.replicate,
        baselineMs: b,
        candidateMs: c,
        baselineTokens: baseline?.inputTokens,
        candidateTokens: candidate.inputTokens,
      });
  }
  const caseIds = [...new Set(pairs.map((p) => p.case))];
  const caseLogs = caseIds.map((id) =>
    mean(
      pairs
        .filter((p) => p.case === id)
        .map((p) => Math.log(p.candidateMs / p.baselineMs)),
    ),
  );
  const ci = bootstrapMeanCI(caseLogs, { resamples: 10000, seed: 1 }).map(
    Math.exp,
  );
  const models = [...new Set(rows.map((r) => r.model))].map((model) => {
    const selected = pairs.filter((p) => p.model === model);
    return {
      model,
      pairs: selected.length,
      medianPairedDeltaMs: median(
        selected.map((p) => p.candidateMs - p.baselineMs),
      ),
      baselineInputMedian: median(selected.map((p) => p.baselineTokens ?? NaN)),
      candidateInputMedian: median(
        selected.map((p) => p.candidateTokens ?? NaN),
      ),
      allTokensRecorded: selected.every(
        (p) =>
          p.baselineTokens !== undefined && p.candidateTokens !== undefined,
      ),
    };
  });
  const complete = pairs.length === expectedPairs && caseIds.length >= 2;
  const failures = models.flatMap((m) => [
    ...(m.medianPairedDeltaMs !== null && m.medianPairedDeltaMs >= 0
      ? [`${m.model}: median paired writer time did not improve`]
      : []),
    ...(m.baselineInputMedian !== null &&
    m.candidateInputMedian !== null &&
    m.candidateInputMedian > m.baselineInputMedian
      ? [`${m.model}: median input tokens increased`]
      : []),
  ]);
  const counters = rows
    .filter((r) => r.system === "tracetoon-candidate")
    .map((r) => r.operationCounts as Record<string, number> | undefined);
  const workEvidence = {
    committedSubmissionReuses: counters.reduce(
      (sum, c) => sum + (c?.["submission.reused"] ?? 0),
      0,
    ),
    batchExpansions: counters.reduce(
      (sum, c) => sum + (c?.["evidence.batchExpansions"] ?? 0),
      0,
    ),
    receiptReuses: counters.reduce(
      (sum, c) => sum + (c?.["check.reused"] ?? 0),
      0,
    ),
    unchangedWritesAvoided: counters.reduce(
      (sum, c) => sum + (c?.["artifact.writesReused"] ?? 0),
      0,
    ),
    scope:
      "Self-reported runtime counters, tested separately; never validation outcome evidence.",
  };
  const workObserved =
    workEvidence.committedSubmissionReuses +
      workEvidence.batchExpansions +
      workEvidence.receiptReuses +
      workEvidence.unchangedWritesAvoided >
    0;
  const validationComparable =
    validationComparability.length === expectedPairs &&
    validationComparability.every((p) => p.status === "matched");
  const unknown =
    !complete ||
    validationComparability.length !== expectedPairs ||
    validationComparability.some((p) => p.status !== "matched") ||
    models.some(
      (m) => !m.allTokensRecorded || m.medianPairedDeltaMs === null,
    ) ||
    !ci.every(Number.isFinite) ||
    ci[1]! >= 1 ||
    (requireWorkEvidence && !workObserved);
  return {
    schema: "prbench.performance/v2",
    validationComparability,
    validationComparable,
    status: !validationComparable
      ? "inconclusive"
      : failures.length
        ? "failed"
        : unknown
          ? "inconclusive"
          : "passed",
    passed: !failures.length && !unknown,
    failures,
    pairs: pairs.length,
    expectedPairs,
    independentCases: caseIds.length,
    workEvidence,
    geometricMeanWriterRatio: caseLogs.length ? Math.exp(mean(caseLogs)) : null,
    writerRatio95CI: ci.map((x) => (Number.isFinite(x) ? x : null)),
    models,
    limitations: [
      "Case-clustered percentile bootstrap; repeats, models and judges are not independent cases.",
      "Service waits and observation overhead are included in writer wall time.",
      "CLI token counts are not USD cost.",
      "Noncomparable validation leaves timing and token differences descriptive; it establishes neither a gain nor a regression.",
    ],
  };
}
