import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admission } from "../src/admission.ts";
import { scopeCalibrationTasks } from "../src/calibration.ts";
import { DIAGNOSTIC_JUDGES, runDiagnostic } from "../src/diagnostic.ts";
import { RUBRIC_KEYS } from "../src/judge/rubric.ts";
import { digest } from "../src/util/hash.ts";
import { cleanupTemps, copyExample, tempDir } from "./helpers.ts";
afterAll(cleanupTemps);

test("admission collects exactly four diagnostic drafts and resumes without writer or judge calls", async () => {
  const cases = copyExample("pr8");
  cpSync(cases.dir, join(cases.root, "pr9"), { recursive: true });
  const caseFile = join(cases.root, "pr9/case.json"),
    second = JSON.parse(readFileSync(caseFile, "utf8"));
  second.id = "pr9";
  writeFileSync(caseFile, JSON.stringify(second));
  const skill = tempDir(),
    bin = join(skill, "bin");
  mkdirSync(bin);
  const runtime = join(
    bin,
    `tracetoon-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
  );
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "fixtures/fake-modern-runtime.ts"),
      "--outfile",
      runtime,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(built.exitCode).toBe(0);
  const manifest = {
    version: "0.0.0-test",
    buildId: "a".repeat(64),
    revision: null,
    protocol: 2,
    dependencies: [
      {
        revision: "b".repeat(40),
        packageTree: "c".repeat(40),
        sha256: "d".repeat(64),
      },
    ],
    compiler: { name: "bun", version: Bun.version },
    recipe: { bunVersion: Bun.version },
  };
  writeFileSync(join(skill, "build.json"), JSON.stringify(manifest));
  writeFileSync(join(skill, "SKILL.md"), "# Synthetic admission skill");
  writeFileSync(join(skill, "VERSION"), "0.0.0-test");
  writeFileSync(
    `${runtime}.build.json`,
    JSON.stringify({
      schema: "tracetoon.build-output/v1",
      buildId: manifest.buildId,
      sha256: digest(readFileSync(runtime)),
      inputManifestSha256: digest(readFileSync(join(skill, "build.json"))),
      compiler: {
        version: Bun.version,
        sha256: digest(readFileSync(process.execPath)),
      },
      target: `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    }),
  );
  const auth = tempDir(),
    log = join(tempDir(), "calls.jsonl");
  writeFileSync(join(auth, "auth.json"), '{"synthetic":true}');
  const emptySide = {
    factualErrors: [],
    unsupportedClaims: [],
    claimAssessments: [],
    claimsCovered: ["C1"],
    contextCovered: [],
    uncertaintiesRespected: [],
    trapsHit: [],
    rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 2])),
    notes: "Synthetic admission.",
  };
  const env = {
    PRBENCH_CODEX_AUTH_HOME: auth,
    PRBENCH_CODEX_COMMAND: JSON.stringify([
      process.execPath,
      join(import.meta.dir, "fixtures/fake-comparison-codex.ts"),
    ]),
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_JUDGMENT: JSON.stringify({
      A: emptySide,
      B: emptySide,
      preferred: "tie",
      preferenceDependsOnMissingEvidence: false,
      reason: "Synthetic equal drafts.",
    }),
  };
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  try {
    const tasks = scopeCalibrationTasks();
    for (const [id, index] of [
      ["historical-pr8", 0],
      ["historical-pr9", 2],
      ["retained-pr8-dispute", 0],
    ] as const)
      tasks.push({
        ...structuredClone(tasks[index]!),
        id,
        phase: "fixture-controls",
      });
    const oracle = tasks.flatMap((t) => t.expected);
    const providers = DIAGNOSTIC_JUDGES.map((id) => ({
      id,
      family: "fixture",
      ask: async (prompt: string) => {
        const targets = JSON.parse(
          /supplied: (\{[^\n]+\})\n/.exec(prompt)![1]!,
        );
        const side = (label: string) => {
          const assessments = targets[label].map((claim: string) => ({
            claim,
            status: oracle.find((e) => e.claim === claim)!.statuses[0],
            evidenceRefs: ["D"],
            reason: "Synthetic protocol fixture.",
          }));
          return {
            ...emptySide,
            claimsCovered: [],
            claimAssessments: assessments,
            factualErrors: assessments
              .filter((a: any) => a.status === "contradicted")
              .map((a: any) => a.claim),
          };
        };
        return {
          text: JSON.stringify({
            A: side("A"),
            B: side("B"),
            preferred: "tie",
            preferenceDependsOnMissingEvidence: false,
            reason: "Synthetic protocol fixture.",
          }),
        };
      },
    }));
    const calibration = join(tempDir(), "calibration");
    expect(
      (
        await runDiagnostic({
          out: calibration,
          kind: "scope-calibration/full",
          tasks,
          judges: providers,
        })
      ).status,
    ).toBe("passed");
    const controls = tempDir();
    for (const id of ["pr8", "pr9"]) {
      const c = JSON.parse(
        readFileSync(join(cases.root, id, "case.json"), "utf8"),
      );
      writeFileSync(
        join(controls, `${id}-corrected.json`),
        JSON.stringify({
          schema: "prbench.artifact/v1",
          case: id,
          system: "corrected",
          title: "Default greeting",
          body: "Greets world by default.",
          base: c.repo.base,
          head: c.repo.head,
          diff: "same change",
          commits: [],
          meta: {
            tool: "fixture",
            startedAt: "2026-11-03T00:00:00Z",
            durationMs: 0,
          },
        }),
      );
    }
    const profile = join(tempDir(), "preparation.json");
    writeFileSync(profile, JSON.stringify({ cases: { pr8: {}, pr9: {} } }));
    const opts = {
      out: join(tempDir(), "admission"),
      candidateSkill: skill,
      cases: cases.root,
      preparation: profile,
      calibration,
      controls,
    };
    const first = await admission(opts);
    expect(first).toMatchObject({
      completedWriters: 4,
      completedOrders: 16,
      newWriterCalls: 4,
      purpose: "diagnostic",
      status: "inconclusive",
    });
    const before = readFileSync(log, "utf8");
    const resumed = await admission({ ...opts, resume: true });
    expect(resumed).toMatchObject({
      newWriterCalls: 0,
      reusedWriters: 4,
      completedWriters: 4,
      completedOrders: 16,
    });
    expect(readFileSync(log, "utf8")).toBe(before);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}, 240000);
