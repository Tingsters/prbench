import { expect, test } from "bun:test";
import { performanceReport, type WriterMetric } from "../src/performance.ts";
const rows = (ratio: number) =>
  ["one", "two", "three"].flatMap((id, i) =>
    ["sol", "terra"].flatMap((model) =>
      [1, 2, 3].flatMap((replicate) => [
        {
          case: id,
          model,
          replicate,
          system: "tracetoon-baseline",
          stageTimings: { writerMs: 1000 + i * 100 },
          inputTokens: 100,
        },
        {
          case: id,
          model,
          replicate,
          system: "tracetoon-candidate",
          stageTimings: { writerMs: (1000 + i * 100) * ratio },
          inputTokens: 90,
        },
      ]),
    ),
  ) as WriterMetric[];
test("performance clusters repeats by case and requires paired time and token gains", () => {
  const report = performanceReport(rows(0.8), 18);
  expect(report).toMatchObject({
    status: "passed",
    pairs: 18,
    independentCases: 3,
  });
  expect(report.writerRatio95CI[1]!).toBeLessThan(1);
  expect(performanceReport(rows(1.1), 18).status).toBe("failed");
  expect(performanceReport(rows(0.8).slice(2), 18).status).toBe("inconclusive");
  const increased = rows(0.8).map((r) =>
    r.system === "tracetoon-candidate" ? { ...r, inputTokens: 110 } : r,
  );
  expect(performanceReport(increased, 18).status).toBe("failed");
});
