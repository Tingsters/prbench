import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeCalibrationTasks } from "../src/calibration.ts";
import {
  runDiagnostic,
  verifiedDiagnosticSummary,
  diagnosticAssessment,
} from "../src/diagnostic.ts";
import { judgmentPath } from "../src/judge/pairwise.ts";
import { RUBRIC_KEYS } from "../src/judge/rubric.ts";
import { assertAdmissionCalibration } from "../src/admission.ts";
import { cleanupTemps, tempDir } from "./helpers.ts";
afterAll(cleanupTemps);

test("targeted controls retain incidental findings while candidate accuracy findings still gate admission", () => {
  const task = scopeCalibrationTasks()[0]!;
  const side = (claim: string) => ({
    claimAssessments: [
      {
        claim,
        status: "unsupported" as const,
        evidenceRefs: ["D"],
        reason: "A separate finding.",
      },
    ],
    factualErrors: [],
    unsupportedClaims: [claim],
    claimsCovered: [],
    contextCovered: [],
    uncertaintiesRespected: [],
    trapsHit: [],
    rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 2])),
    notes: "Fixture.",
  });
  const pair: any = {
    judge: "fixture",
    sides: {
      [task.x.system]: [side("Unselected control defect.")],
      [task.y.system]: [side("Unselected candidate defect.")],
    },
  };
  const targeted = diagnosticAssessment(
    { ...task, expected: [], accuracySystems: [] },
    pair,
  );
  expect(targeted.additionalFindings).toHaveLength(2);
  expect(targeted.unresolved).toHaveLength(0);
  const admission = diagnosticAssessment(
    { ...task, expected: [], accuracySystems: [task.y.system] },
    pair,
  );
  expect(admission.additionalFindings).toHaveLength(2);
  expect(admission.unresolved).toHaveLength(1);
  expect(admission.unresolved[0]).toContain("candidate defect");
});

test("missing selected assessments get one persisted format repair rather than being silently accepted", async () => {
  const tasks = scopeCalibrationTasks().slice(0, 1),
    out = join(tempDir(), "format");
  let calls = 0;
  const judge = {
    id: "fixture:required",
    family: "fixture",
    ask: async (prompt: string) => {
      calls++;
      const targets = JSON.parse(/supplied: (\{[^\n]+\})\n/.exec(prompt)![1]!);
      const side = (label: string) => ({
        claimAssessments:
          calls === 1
            ? []
            : targets[label].map((claim: string) => ({
                claim,
                status: "supported",
                evidenceRefs: ["D"],
                reason: "Synthetic source fixture.",
              })),
        factualErrors: [],
        unsupportedClaims: [],
        claimsCovered: [],
        contextCovered: [],
        uncertaintiesRespected: [],
        trapsHit: [],
        rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 2])),
        notes: "Synthetic response.",
      });
      if (calls === 2) expect(prompt).toContain("FORMAT CORRECTION ONLY");
      return {
        text: JSON.stringify({
          A: side("A"),
          B: side("B"),
          preferred: "tie",
          preferenceDependsOnMissingEvidence: false,
          reason: "Synthetic.",
        }),
      };
    },
  };
  const opts = { out, kind: "fixture", tasks, judges: [judge] };
  expect((await runDiagnostic(opts)).status).toBe("passed");
  expect(calls).toBe(3);
  expect((await runDiagnostic({ ...opts, resume: true })).newJudgeCalls).toBe(
    0,
  );
  expect(calls).toBe(3);
}, 30000);

test("fixed calibration keeps expected labels outside packets and resumes accepted judgments with zero calls", async () => {
  const tasks = scopeCalibrationTasks(),
    out = join(tempDir(), "diagnostic");
  let calls = 0;
  const expectations = tasks.flatMap((t) => t.expected);
  (tasks[0]!.expected[0] as any).goldOnly = "GOLD_ONLY_DO_NOT_SEND";
  const judge = {
    id: "fixture:scope",
    family: "fixture",
    ask: async (prompt: string) => {
      calls++;
      expect(prompt).not.toContain("GOLD_ONLY_DO_NOT_SEND");
      expect(prompt).not.toContain(
        "This paragraph describes the new repository-edit selection path",
      );
      const targets = JSON.parse(
        /Explicitly assess these selected clauses[^\n]+supplied: (\{[^\n]+\})\n/.exec(
          prompt,
        )![1]!,
      );
      const side = (label: "A" | "B") => {
        const claimAssessments = targets[label].map((claim: string) => ({
          claim,
          status: expectations.find((e) => e.claim === claim)!.statuses[0],
          evidenceRefs: ["D"],
          reason: "Synthetic provider checks packet plumbing only.",
        }));
        return {
          claimAssessments,
          factualErrors: claimAssessments
            .filter((a: any) => a.status === "contradicted")
            .map((a: any) => a.claim),
          unsupportedClaims: [],
          claimsCovered: [],
          contextCovered: [],
          uncertaintiesRespected: [],
          trapsHit: [],
          rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 2])),
          notes: "Synthetic response.",
        };
      };
      return {
        text: JSON.stringify({
          A: side("A"),
          B: side("B"),
          preferred: "tie",
          preferenceDependsOnMissingEvidence: false,
          reason: "Equal synthetic drafts.",
        }),
      };
    },
  };
  const opts = {
    out,
    kind: "scope-calibration/examples",
    tasks,
    judges: [judge],
  };
  const result = await runDiagnostic(opts);
  expect(result.status).toBe("passed");
  expect(calls).toBe(8);
  expect(verifiedDiagnosticSummary(out).completedOrders).toBe(8);
  expect(() => assertAdmissionCalibration(out)).toThrow("28-order calibration");
  const resumed = await runDiagnostic({ ...opts, resume: true });
  expect(resumed.newJudgeCalls).toBe(0);
  expect(calls).toBe(8);
  const task = tasks[0]!,
    file = judgmentPath(
      join(out, "judgments", task.id),
      task.loaded.case.id,
      judge.id,
      task.x.system,
      task.y.system,
      "ab",
    );
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.judgment.reason = "Changed but still schema-valid.";
  writeFileSync(file, JSON.stringify(raw));
  const rejected = await runDiagnostic({ ...opts, resume: true });
  expect(rejected.status).toBe("incomplete");
  expect(rejected.error).toContain("judgment bytes changed");
  expect(calls).toBe(8);
}, 30000);

test("a target disagreement stops before a later phase without a quality reroll", async () => {
  const tasks = scopeCalibrationTasks().slice(0, 2);
  tasks[1]!.phase = "later";
  let calls = 0;
  const judge = {
    id: "fixture:disagree",
    family: "fixture",
    ask: async (prompt: string) => {
      calls++;
      const targets = JSON.parse(/supplied: (\{[^\n]+\})\n/.exec(prompt)![1]!);
      const side = (label: string) => ({
        claimAssessments: targets[label].map((claim: string) => ({
          claim,
          status: "unverifiable",
          evidenceRefs: [],
          reason: "Synthetic disagreement.",
        })),
        factualErrors: [],
        unsupportedClaims: [],
        claimsCovered: [],
        contextCovered: [],
        uncertaintiesRespected: [],
        trapsHit: [],
        rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, null])),
        notes: "Unknown.",
      });
      return {
        text: JSON.stringify({
          A: side("A"),
          B: side("B"),
          preferred: "inconclusive",
          preferenceDependsOnMissingEvidence: true,
          reason: "Unknown.",
        }),
      };
    },
  };
  const result = await runDiagnostic({
    out: join(tempDir(), "failed"),
    kind: "fixture",
    tasks,
    judges: [judge],
  });
  expect(result.status).toBe("failed");
  expect(result.stoppedAfter).toBe("scope");
  expect(calls).toBe(2);
  expect(result.expectedOrders).toBe(4);
  expect(result.completedOrders).toBe(2);
}, 30000);
