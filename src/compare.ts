export {
  directoryDigest,
  runtimeIdentity,
  prepareCase,
} from "./run/comparisonInputs.ts";
export interface CompareOptions {
  baselineSkill: string;
  candidateSkill: string;
  cases: string;
  split: string;
  out: string;
  resume?: boolean;
  plan?: boolean;
  reportOnly?: boolean;
  replicates?: number;
  purpose?: string;
  cache?: string;
  timeoutMs?: number;
  preparation?: string;
  prepareOnly?: boolean;
  verifyOnly?: boolean;
  development?: string;
  reuseFrom?: string;
  recoverLock?: boolean;
  /** codex (default) or claude; `both` is expanded by the CLI into two runs. */
  provider?: string;
  /** Concurrent writer/judge jobs for this provider (default 4). */
  parallel?: number;
  /** Writer models, replacing the provider's defaults; the judges stay the same. */
  models?: string[];
}
export function assertResume(expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error(
      "Experiment inputs changed; use a new output directory rather than reusing artifacts.",
    );
}

/** Operational diagnostics are separate from the description quality score. */
export function operationSummary(metrics: Record<string, any>[]) {
  const median = (values: unknown[]) => {
    const numbers = values
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
      .sort((a, b) => a - b);
    return numbers.length
      ? (numbers[Math.floor((numbers.length - 1) / 2)]! +
          numbers[Math.floor(numbers.length / 2)]!) /
          2
      : null;
  };
  const groups = new Map<string, Record<string, any>[]>();
  const stages = (items: Record<string, any>[]) => {
    const entries = items.flatMap((i) => i.toolTimings ?? []) as {
      stage: string;
      durationMs: number;
    }[];
    return Object.fromEntries(
      [...new Set(entries.map((e) => e.stage))].sort().map((stage) => {
        const values = entries
          .filter((e) => e.stage === stage)
          .map((e) => e.durationMs);
        return [
          stage,
          {
            records: values.length,
            totalMs: values.reduce((a, b) => a + b, 0),
            medianMs: median(values),
          },
        ];
      }),
    );
  };
  for (const item of metrics) {
    const key = `${item.model}/${item.system}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map((items) => ({
    model: items[0]!.model as string,
    system: items[0]!.system as string,
    cases: items.length,
    writerMedianMs: median(items.map((i) => i.stageTimings?.writerMs)),
    authWaitMedianMs: median(items.map((i) => i.stageTimings?.authWaitMs)),
    inputTokenMedian: median(items.map((i) => i.inputTokens)),
    outputTokenMedian: median(items.map((i) => i.outputTokens)),
    writerErrors: items.filter((i) => i.writerOutcome?.isError).length,
    pendingCleanup: items.filter((i) => i.cleanup === "pending").length,
    toolTimingCases: items.filter((i) => i.toolTimings?.length).length,
    toolTimingGapCases: items.filter((i) => i.toolTimingGaps?.length).length,
    toolStages: stages(items),
  }));
}

export async function compare(opts: CompareOptions) {
  const { compareV2 } = await import("./comparison.ts");
  return compareV2(opts);
}
