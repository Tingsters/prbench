import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { compare } from "../src/compare.ts";
import { RUBRIC_KEYS } from "../src/judge/rubric.ts";
import { artifactDigest } from "../src/schema/artifact.ts";
import { cleanupTemps, copyExample, tempDir } from "./helpers.ts";
afterAll(cleanupTemps);

async function fakeComparisonSetup() {
  const cases = copyExample("comparison-smoke");
  const skill = tempDir(),
    bin = join(skill, "bin");
  mkdirSync(bin);
  const name = `tracetoon-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  const compiled = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "fixtures", "fake-comparison-runtime.ts"),
      "--outfile",
      join(bin, name),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(compiled.exitCode).toBe(0);
  writeFileSync(join(skill, "SKILL.md"), "# Synthetic skill");
  writeFileSync(join(skill, "VERSION"), "0.0.0-test");
  writeFileSync(
    join(skill, "build.json"),
    JSON.stringify({ version: "0.0.0-test", buildId: "a".repeat(64) }),
  );
  const candidate = join(tempDir(), "skill");
  cpSync(skill, candidate, { recursive: true });
  const auth = tempDir(),
    log = join(tempDir(), "calls.jsonl");
  writeFileSync(join(auth, "auth.json"), '{"synthetic":true}');
  const side = {
    factualErrors: [],
    unsupportedClaims: [],
    claimAssessments: [],
    claimsCovered: ["C1"],
    contextCovered: [],
    uncertaintiesRespected: [],
    trapsHit: [],
    rubric: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 2])),
    notes: "Synthetic equal drafts.",
  };
  const vars = {
    PRBENCH_CODEX_AUTH_HOME: auth,
    PRBENCH_CODEX_COMMAND: JSON.stringify([
      process.execPath,
      join(import.meta.dir, "fixtures", "fake-comparison-codex.ts"),
    ]),
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_SCOPE_ONCE: join(tempDir(), "scope-once"),
    FAKE_CODEX_JUDGMENT: JSON.stringify({
      A: side,
      B: side,
      preferred: "tie",
      preferenceDependsOnMissingEvidence: false,
      reason: "Equal synthetic drafts.",
    }),
  };
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, vars);
  const restore = () => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
  return { cases, skill, candidate, log, restore };
}

test("frozen comparison runs three systems, both orders, and resumes only matching artifacts", async () => {
  const { cases, skill, candidate, log, restore } = await fakeComparisonSetup();
  const opts = {
    baselineSkill: skill,
    candidateSkill: candidate,
    cases: cases.root,
    split: "dev",
    out: join(tempDir(), "experiment"),
    purpose: "diagnostic",
    replicates: 1,
  };
  try {
    await compare(opts);
    const summary = JSON.parse(
      readFileSync(join(opts.out, "summary.json"), "utf8"),
    );
    expect(summary.writerMetrics.length).toBe(6);
    // The first writer typed a path outside its sandbox: that sample is
    // rejected and retried, and the run still completes.
    const failures = Bun.spawnSync(["find", join(opts.out, "attempts", "writer"), "-name", "failure.json"])
      .stdout.toString().trim().split("\n").filter(Boolean)
      .map((f) => JSON.parse(readFileSync(f, "utf8")));
    expect(failures.map((f: any) => f.failureKind)).toEqual(["scope"]);
    expect(readFileSync(join(opts.out, "summary.md"), "utf8")).toContain("Scope-rejected attempts");
    expect(summary.reports.length).toBe(4);
    expect(
      summary.reports.every(
        (r: any) =>
          r.report.coverage.completed === 2 && r.report.coverage.expected === 2,
      ),
    ).toBe(true);
    expect(summary.coverage.complete).toBe(true);
    expect(summary.adoptionGate.passed).toBe(false);
    const isolation = JSON.parse(
      readFileSync(join(opts.out, "isolation.json"), "utf8"),
    );
    expect(isolation.probes.length).toBe(6);
    expect(
      isolation.probes.every(
        (p: any) => p.passed && p.catalogue.toolCalls === 0,
      ),
    ).toBe(true);
    expect(
      summary.operations
        .filter((r: any) => r.system !== "codex-native")
        .every(
          (r: any) =>
            r.toolTimingCases === 1 && r.toolStages.digest.totalMs === 7,
        ),
    ).toBe(true);
    const before = readFileSync(log, "utf8");
    await compare({ ...opts, resume: true });
    expect(readFileSync(log, "utf8")).toBe(before);
    // Simulate a completed generation rejected by an older scope checker,
    // before its accepted artifact/receipt were committed. Recovery must use
    // its immutable generation cache, retain the rejection, and call no model.
    const recoveredPath = join(
        opts.out,
        "gpt-6.1-sol",
        "artifacts",
        "comparison-smoke",
        "tracetoon-candidate.json",
      ),
      generation = readFileSync(recoveredPath, "utf8"),
      rejectionPath = recoveredPath.replace(".json", ".isolation-failure.json"),
      rejection = JSON.stringify({
        experiment: isolation.experiment,
        findings: [{ commandId: "V1", kind: "old-false-positive" }],
      });
    writeFileSync(rejectionPath, rejection);
    unlinkSync(recoveredPath);
    unlinkSync(recoveredPath.replace(".json", ".receipt.json"));
    await compare({ ...opts, resume: true });
    expect(readFileSync(log, "utf8")).toBe(before);
    expect(readFileSync(recoveredPath, "utf8")).toBe(generation);
    expect(readFileSync(rejectionPath, "utf8")).toBe(rejection);
    expect(
      JSON.parse(
        readFileSync(
          recoveredPath.replace(".json", ".scope-audit.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      artifactDigest: artifactDigest(JSON.parse(generation)),
      findings: [],
    });
    const caseFile = join(cases.dir, "facts.json"),
      factsRaw = readFileSync(caseFile, "utf8"),
      facts = JSON.parse(factsRaw);
    facts.context.push("A corrected source-backed fact for the replay.");
    writeFileSync(caseFile, JSON.stringify(facts));
    const replayOut = join(tempDir(), "replay");
    await compare({ ...opts, out: replayOut, reuseFrom: opts.out });
    const replay = JSON.parse(
      readFileSync(join(replayOut, "summary.json"), "utf8"),
    );
    const sourceManifest = JSON.parse(
      readFileSync(join(opts.out, "manifest.json"), "utf8"),
    );
    const replayManifest = JSON.parse(
      readFileSync(join(replayOut, "manifest.json"), "utf8"),
    );
    expect(replayManifest.performanceBlock).toBe(
      sourceManifest.performanceBlock,
    );
    expect(replay.writerMetrics).toHaveLength(6);
    expect(replay.operationalHistory.state.newWriterCalls).toBe(0);
    expect(replay.operationalHistory.state.newJudgeCalls).toBe(16);
    expect(replay.operationalHistory.state.reusedWriters).toBe(6);
    const afterReplay = readFileSync(log, "utf8");
    await compare({ ...opts, out: replayOut, resume: true, reportOnly: true });
    expect(readFileSync(log, "utf8")).toBe(afterReplay);
    writeFileSync(caseFile, factsRaw);
    const proofPath = join(opts.out, "isolation.receipt.json");
    const proof = readFileSync(proofPath, "utf8");
    writeFileSync(
      proofPath,
      JSON.stringify({ experiment: isolation.experiment, digest: "forged" }),
    );
    await expect(compare({ ...opts, resume: true })).rejects.toThrow(
      "isolation proof",
    );
    writeFileSync(proofPath, proof);
    const artifactPath = join(
      opts.out,
      "gpt-6.1-sol",
      "artifacts",
      "comparison-smoke",
      "codex-native.json",
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    artifact.validation.commands.push({
      id: "V99",
      source: "synthetic",
      command: "cat <user>/.agents/skills/tracetoon/SKILL.md",
      cwd: "<repo>",
      outcome: "completed",
      exitCode: 0,
      output: "",
      truncated: false,
    });
    artifact.validation.coverage = "partial";
    writeFileSync(artifactPath, JSON.stringify(artifact));
    writeFileSync(
      artifactPath.replace(".json", ".receipt.json"),
      JSON.stringify({
        experiment: isolation.experiment,
        digest: artifactDigest(artifact),
      }),
    );
    await expect(compare({ ...opts, resume: true })).rejects.toThrow(
      "outside case inputs",
    );
    expect(readFileSync(log, "utf8")).toBe(afterReplay);
    // The current audit names the real finding (.isolation-failure.json keeps
    // the first rejection of this key as history).
    const failure = JSON.parse(
      readFileSync(artifactPath.replace(".json", ".scope-audit.json"), "utf8"),
    );
    expect(failure.findings).toEqual([
      { commandId: "V99", kind: "host-agent-state" },
    ]);
    // A retained failure marker also cannot bypass a real current finding.
    await expect(compare({ ...opts, resume: true })).rejects.toThrow(
      "outside case inputs",
    );
    expect(readFileSync(log, "utf8")).toBe(afterReplay);
    writeFileSync(join(candidate, "SKILL.md"), "# Changed input");
    await expect(compare({ ...opts, resume: true })).rejects.toThrow(
      "inputs changed",
    );
  } finally {
    restore();
  }
}, 240_000);

test("--systems baseline,candidate plans no native writers and only candidate-vs-baseline judgments", async () => {
  const { cases, skill, candidate, restore } = await fakeComparisonSetup();
  try {
    for (const id of ["two", "three", "four", "five"])
      cpSync(cases.dir, join(cases.root, id), { recursive: true });
    for (const id of ["two", "three", "four", "five"]) {
      const file = join(cases.root, id, "case.json"),
        c = JSON.parse(readFileSync(file, "utf8"));
      c.id = id;
      writeFileSync(file, JSON.stringify(c, null, 2));
    }
    const base = {
      baselineSkill: skill,
      candidateSkill: candidate,
      cases: cases.root,
      split: "dev",
      out: join(tempDir(), "plan"),
      purpose: "diagnostic",
      replicates: 3,
      plan: true,
    };
    const all: any = await compare(base);
    expect(all.writers).toBe(5 * 2 * 3 * 3);
    expect(all.orders).toBe(5 * 2 * 2 * 2 * 2 * 3);
    expect(all.judgedAgainst).toEqual(["tracetoon-baseline", "codex-native"]);
    const plan: any = await compare({
      ...base,
      systems: ["baseline", "tracetoon-candidate"],
    });
    // 2 models × 5 cases × 3 replicates × 2 systems; one pairing × 2 judges × 2 orders.
    expect(plan.writers).toBe(60);
    expect(plan.orders).toBe(120);
    expect(plan.systems).toEqual(["tracetoon-baseline", "tracetoon-candidate"]);
    expect(plan.judgedAgainst).toEqual(["tracetoon-baseline"]);
    expect(plan.jobs).toHaveLength(60);
    expect(plan.jobs.some((j: any) => j.system === "codex-native")).toBe(false);
    // The native name and full names are accepted; candidate and baseline are required.
    expect(
      ((await compare({ ...base, systems: ["codex-native", "baseline", "candidate"] })) as any).writers,
    ).toBe(90);
    await expect(compare({ ...base, systems: ["native", "candidate"] })).rejects.toThrow("baseline and candidate");
    await expect(compare({ ...base, systems: ["baseline", "native"] })).rejects.toThrow("baseline and candidate");
    await expect(compare({ ...base, systems: ["baseline", "candidate", "gpt"] })).rejects.toThrow("Unknown system");
  } finally {
    restore();
  }
}, 240_000);

test("a run without native completes, scores, and records its systems for resume", async () => {
  const { cases, skill, candidate, log, restore } = await fakeComparisonSetup();
  const opts = {
    baselineSkill: skill,
    candidateSkill: candidate,
    cases: cases.root,
    split: "dev",
    out: join(tempDir(), "experiment"),
    purpose: "diagnostic",
    replicates: 1,
    systems: ["baseline", "candidate"],
  };
  try {
    await compare(opts);
    const summary = JSON.parse(readFileSync(join(opts.out, "summary.json"), "utf8"));
    expect(summary.writerMetrics.map((m: any) => m.system).sort()).toEqual([
      "tracetoon-baseline",
      "tracetoon-baseline",
      "tracetoon-candidate",
      "tracetoon-candidate",
    ]);
    expect(summary.coverage).toMatchObject({
      writers: 4,
      expectedWriters: 4,
      orders: 8,
      expectedOrders: 8,
      complete: true,
    });
    expect(summary.reports.map((r: any) => r.comparison)).toEqual([
      "tracetoon-baseline",
      "tracetoon-baseline",
    ]);
    expect(summary.qualityGate.failures.join("\n")).not.toContain("native");
    expect(summary.scores.length).toBe(4);
    expect(summary.scores.some((d: any) => d.system === "codex-native")).toBe(false);
    const md = readFileSync(join(opts.out, "summary.md"), "utf8");
    expect(md).toContain("| gpt-6.1-sol | tracetoon-baseline | 1 | 0.0 [–, –] | – | 0.00 |");
    expect(md.split("Paired candidate − other system")[1]!.split("\n\n")[1]).not.toContain("native");
    expect(md).toContain("Composite Δ [95% CI]");
    const manifest = JSON.parse(readFileSync(join(opts.out, "manifest.json"), "utf8"));
    expect(manifest.settings.systems).toEqual(["tracetoon-baseline", "tracetoon-candidate"]);
    const isolation = JSON.parse(readFileSync(join(opts.out, "isolation.json"), "utf8"));
    expect(isolation.probes.length).toBe(4);
    // Resume keeps the frozen systems; asking for different ones is a new experiment.
    const before = readFileSync(log, "utf8");
    await compare({ ...opts, systems: undefined, resume: true });
    await compare({ ...opts, resume: true, reportOnly: true });
    expect(readFileSync(log, "utf8")).toBe(before);
    await expect(compare({ ...opts, resume: true, systems: ["native", "baseline", "candidate"] })).rejects.toThrow(
      "inputs changed",
    );
  } finally {
    restore();
  }
}, 240_000);
