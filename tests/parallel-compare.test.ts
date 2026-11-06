import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { compare, type CompareOptions } from "../src/compare.ts";
import { RUBRIC_KEYS } from "../src/judge/rubric.ts";
import { cleanupTemps, copyExample, tempDir } from "./helpers.ts";
afterAll(cleanupTemps);

const runtimeName = `tracetoon-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

function skills() {
  const skill = tempDir(),
    bin = join(skill, "bin");
  mkdirSync(bin);
  const compiled = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "fixtures", "fake-comparison-runtime.ts"),
      "--outfile",
      join(bin, runtimeName),
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
  return { baselineSkill: skill, candidateSkill: candidate };
}

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
const judgment = JSON.stringify({
  A: side,
  B: side,
  preferred: "tie",
  preferenceDependsOnMissingEvidence: false,
  reason: "Equal synthetic drafts.",
});

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>) {
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

type Span = { kind: string; start: number; end: number };
const spans = (file: string): Span[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
function peakOverlap(list: Span[]) {
  const edges = list
    .flatMap((s) => [
      [s.start, 1],
      [s.end, -1],
    ])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  let now = 0,
    peak = 0;
  for (const [, d] of edges) peak = Math.max(peak, (now += d!));
  return peak;
}

/** What a comparison concluded, without timings, paths or experiment ids. */
function outcome(root: string, models: string[], comparisons: string[]) {
  const out: Record<string, unknown> = {};
  for (const model of models)
    for (const comparison of comparisons) {
      const pairs = JSON.parse(
        readFileSync(join(root, model, comparison, "pairs.json"), "utf8"),
      );
      out[`${model}/${comparison}`] = pairs.map((p: any) => ({
        case: p.case,
        judge: p.judge,
        x: p.x,
        y: p.y,
        verdicts: p.verdicts ?? p.preferred ?? null,
      }));
    }
  const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
  out.coverage = { ...summary.coverage };
  out.quality = summary.qualityGate.status;
  return out;
}

test("parallel codex comparison overlaps runs and reaches the same result as serial", async () => {
  const cases = copyExample("parallel-smoke");
  const auth = tempDir();
  writeFileSync(join(auth, "auth.json"), '{"synthetic":true}');
  const serialSpans = join(tempDir(), "serial.jsonl"),
    parallelSpans = join(tempDir(), "parallel.jsonl");
  const base = {
    ...skills(),
    cases: cases.root,
    split: "dev",
    purpose: "diagnostic",
    replicates: 1,
  };
  const env = (spansFile: string) => ({
    PRBENCH_CODEX_AUTH_HOME: auth,
    PRBENCH_CODEX_COMMAND: JSON.stringify([
      process.execPath,
      join(import.meta.dir, "fixtures", "fake-comparison-codex.ts"),
    ]),
    FAKE_CODEX_JUDGMENT: judgment,
    FAKE_CODEX_SPANS: spansFile,
    FAKE_CODEX_DELAY_MS: "300",
  });
  const serial: CompareOptions = {
    ...base,
    out: join(tempDir(), "serial"),
    parallel: 1,
  };
  const parallel: CompareOptions = {
    ...base,
    out: join(tempDir(), "parallel"),
    parallel: 3,
  };
  await withEnv(env(serialSpans), () => compare(serial));
  await withEnv(env(parallelSpans), () => compare(parallel));

  // Serial never overlaps; parallel does, within the limit.
  expect(peakOverlap(spans(serialSpans))).toBe(1);
  const p = spans(parallelSpans);
  expect(peakOverlap(p)).toBeGreaterThanOrEqual(2);
  expect(peakOverlap(p)).toBeLessThanOrEqual(3);
  // Judging starts before every writer has finished.
  const lastWriterEnd = Math.max(
    ...p.filter((s) => s.kind === "writer").map((s) => s.end),
  );
  expect(p.some((s) => s.kind === "judge" && s.start < lastWriterEnd)).toBe(
    true,
  );

  const models = ["gpt-6.1-sol", "gpt-6.1-terra"],
    comparisons = ["tracetoon-baseline", "codex-native"];
  expect(outcome(parallel.out, models, comparisons)).toEqual(
    outcome(serial.out, models, comparisons),
  );
  // Shared login: no sandbox kept a private copy, and the lease is gone.
  expect(readFileSync(join(auth, "auth.json"), "utf8")).toBe(
    '{"synthetic":true}',
  );
  expect(
    require("node:fs")
      .readdirSync(auth)
      .some((n: string) => n.endsWith(".lease")),
  ).toBe(false);
  const state = JSON.parse(
    readFileSync(join(parallel.out, "state.json"), "utf8"),
  );
  expect(state.parallel).toBe(3);
  expect(state.status).toBe("complete");
}, 600_000);

test("a frozen experiment refuses to resume under another provider", async () => {
  const cases = copyExample("provider-guard");
  const auth = tempDir();
  writeFileSync(join(auth, "auth.json"), '{"synthetic":true}');
  const opts: CompareOptions = {
    ...skills(),
    cases: cases.root,
    split: "dev",
    purpose: "diagnostic",
    replicates: 1,
    out: join(tempDir(), "exp"),
    prepareOnly: true,
  };
  await withEnv(
    {
      PRBENCH_CODEX_AUTH_HOME: auth,
      PRBENCH_CODEX_COMMAND: JSON.stringify([
        process.execPath,
        join(import.meta.dir, "fixtures", "fake-comparison-codex.ts"),
      ]),
    },
    async () => {
      await compare(opts);
      await expect(
        compare({ ...opts, resume: true, provider: "claude" }),
      ).rejects.toThrow(/frozen for Codex/);
    },
  );
}, 120_000);

const claudeEnv = (spansLog: string, token = "synthetic-claude-token") => ({
  PRBENCH_CLAUDE_COMMAND: JSON.stringify([
    process.execPath,
    join(import.meta.dir, "fixtures", "fake-claude.ts"),
  ]),
  PRBENCH_CLAUDE_OAUTH_TOKEN: token,
  FAKE_CLAUDE_MODE: "comparison",
  FAKE_CLAUDE_JUDGMENT: judgment,
  FAKE_CLAUDE_LOG: spansLog,
  FAKE_CLAUDE_DELAY_MS: "200",
});

test("claude comparison runs end to end with Claude writers and Claude judges only", async () => {
  const cases = copyExample("claude-smoke");
  const log = join(tempDir(), "claude.jsonl");
  const opts: CompareOptions = {
    ...skills(),
    cases: cases.root,
    split: "dev",
    purpose: "diagnostic",
    replicates: 1,
    out: join(tempDir(), "claude"),
    provider: "claude",
    parallel: 3,
  };
  await withEnv(claudeEnv(log), () => compare(opts));
  const manifest = JSON.parse(
    readFileSync(join(opts.out, "manifest.json"), "utf8"),
  );
  expect(manifest.settings.provider).toBe("claude");
  expect(manifest.settings.models).toEqual([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
  ]);
  expect(
    manifest.settings.judges.every((j: string) => j.startsWith("claude:")),
  ).toBe(true);
  const summary = JSON.parse(
    readFileSync(join(opts.out, "summary.json"), "utf8"),
  );
  expect(summary.coverage.complete).toBe(true);
  expect(summary.writerMetrics.length).toBe(6);
  expect(new Set(summary.writerMetrics.map((m: any) => m.system))).toEqual(
    new Set(["claude-native", "tracetoon-baseline", "tracetoon-candidate"]),
  );
  expect(summary.reports.map((r: any) => r.comparison).sort()).toEqual([
    "claude-native",
    "claude-native",
    "tracetoon-baseline",
    "tracetoon-baseline",
  ]);
  const isolation = JSON.parse(
    readFileSync(join(opts.out, "isolation.json"), "utf8"),
  );
  expect(isolation.probes.length).toBe(6);
  expect(isolation.probes.every((p: any) => p.passed)).toBe(true);
  // No Codex judge ever appears, and the token never reaches argv or reports.
  const tree = Bun.spawnSync([
    "grep",
    "-rl",
    "--exclude-dir=inputs",
    "codex:",
    opts.out,
  ]).stdout.toString();
  expect(tree.trim()).toBe("");
  const calls = readFileSync(log, "utf8");
  expect(
    calls
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .some((c: any) =>
        (c.args ?? []).join(" ").includes("synthetic-claude-token"),
      ),
  ).toBe(false);
  expect(
    Bun.spawnSync(["grep", "-rl", "synthetic-claude-token", opts.out])
      .stdout.toString()
      .trim(),
  ).toBe("");
}, 600_000);

test("--models replaces the writer models and keeps the provider's judges", async () => {
  const cases = copyExample("claude-smoke");
  const log = join(tempDir(), "claude.jsonl");
  const opts: CompareOptions = {
    ...skills(),
    cases: cases.root,
    split: "dev",
    purpose: "diagnostic",
    replicates: 1,
    out: join(tempDir(), "claude-models"),
    provider: "claude",
    parallel: 3,
    models: ["claude-haiku-5-5"],
  };
  await withEnv(claudeEnv(log), () => compare(opts));
  const manifest = JSON.parse(
    readFileSync(join(opts.out, "manifest.json"), "utf8"),
  );
  expect(manifest.settings.models).toEqual(["claude-haiku-5-5"]);
  expect(manifest.settings.judges).toEqual([
    "claude:claude-opus-5-5@medium",
    "claude:claude-sonnet-5-5@medium",
  ]);
  const summary = JSON.parse(
    readFileSync(join(opts.out, "summary.json"), "utf8"),
  );
  expect(summary.coverage.complete).toBe(true);
  expect(new Set(summary.writerMetrics.map((m: any) => m.model))).toEqual(
    new Set(["claude-haiku-5-5"]),
  );
  // The writer CLI received the chosen model.
  const writerModels = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).args ?? [])
    .filter((a: string[]) => !a.includes("--json-schema"))
    .map((a: string[]) => a[a.indexOf("--model") + 1])
    .filter(Boolean);
  expect(writerModels).toContain("claude-haiku-5-5");
  await expect(
    compare({ ...opts, out: join(tempDir(), "dup"), models: ["a", "a"] }),
  ).rejects.toThrow(/distinct/);
}, 600_000);

test("--provider both runs two independent comparisons", async () => {
  const cases = copyExample("both-smoke");
  const auth = tempDir();
  writeFileSync(join(auth, "auth.json"), '{"synthetic":true}');
  const out = join(tempDir(), "both");
  const s = skills();
  const env = {
    ...process.env,
    ...claudeEnv(join(tempDir(), "claude.jsonl")),
    PRBENCH_CODEX_AUTH_HOME: auth,
    PRBENCH_CODEX_COMMAND: JSON.stringify([
      process.execPath,
      join(import.meta.dir, "fixtures", "fake-comparison-codex.ts"),
    ]),
    FAKE_CODEX_JUDGMENT: judgment,
  };
  const proc = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "cli.ts"),
      "compare",
      "--baseline-skill",
      s.baselineSkill,
      "--candidate-skill",
      s.candidateSkill,
      "--cases",
      cases.root,
      "--out",
      out,
      "--purpose",
      "diagnostic",
      "--replicates",
      "1",
      "--provider",
      "both",
      "--parallel",
      "3",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const text = proc.stdout.toString();
  expect(text).toContain("[both] codex: exit");
  expect(text).toContain("[both] claude: exit");
  for (const provider of ["codex", "claude"]) {
    const summary = JSON.parse(
      readFileSync(join(out, provider, "summary.json"), "utf8"),
    );
    expect(summary.coverage.complete).toBe(true);
    const judges = JSON.parse(
      readFileSync(join(out, provider, "manifest.json"), "utf8"),
    ).settings.judges as string[];
    expect(judges.every((j) => j.startsWith(`${provider}:`))).toBe(true);
  }
}, 900_000);

test("the Claude environment identity ignores where the command was launched from", async () => {
  const { comparisonProvider } = await import("../src/run/provider.ts");
  const hash = (cwd: string) =>
    withEnv(
      {
        PWD: cwd,
        OLDPWD: cwd,
        INIT_CWD: cwd,
        npm_package_json: `${cwd}/package.json`,
      },
      async () => comparisonProvider("claude").environmentHash(),
    );
  expect(await hash("/one")).toBe(await hash("/two"));
});
