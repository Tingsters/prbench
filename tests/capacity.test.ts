/**
 * Capacity smoke: four `compare` controllers at once (two Codex, two Claude),
 * each with --parallel 12, laid out like a real round
 * (`<round>/<run>/<provider>`), so a run's Codex and Claude controllers share
 * their parent's stage cache and every controller shares one cold preflight
 * mirror cache and one Codex login. Fake agents only; no model calls.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUBRIC_KEYS } from "../src/judge/rubric.ts";
import { cleanupTemps, copyExample, tempDir } from "./helpers.ts";
afterAll(cleanupTemps);

const runtimeName = `tracetoon-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

function skills() {
  const skill = tempDir(),
    bin = join(skill, "bin");
  mkdirSync(bin);
  const compiled = Bun.spawnSync(
    [process.execPath, "build", "--compile", join(import.meta.dir, "fixtures", "fake-comparison-runtime.ts"), "--outfile", join(bin, runtimeName)],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(compiled.exitCode).toBe(0);
  writeFileSync(join(skill, "SKILL.md"), "# Synthetic skill");
  writeFileSync(join(skill, "VERSION"), "0.0.0-test");
  writeFileSync(join(skill, "build.json"), JSON.stringify({ version: "0.0.0-test", buildId: "a".repeat(64) }));
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
const judgment = JSON.stringify({ A: side, B: side, preferred: "tie", preferenceDependsOnMissingEvidence: false, reason: "Equal synthetic drafts." });

function peakOverlap(file: string) {
  if (!existsSync(file)) return 0;
  const edges = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { start: number; end: number })
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

test("four concurrent compare controllers at --parallel 12 do not collide", async () => {
  const cases = copyExample("capacity-smoke");
  const s = skills();
  const auth = tempDir();
  writeFileSync(join(auth, "auth.json"), '{"synthetic":true}');
  const round = tempDir("prbench-r10-");
  // A cold mirror cache, so all four controllers race to create it.
  const preflightCache = join(tempDir(), "preflight");
  const runs = [
    { run: "a", provider: "codex" },
    { run: "a", provider: "claude" },
    { run: "b", provider: "codex" },
    { run: "b", provider: "claude" },
  ].map((r) => ({ ...r, out: join(round, r.run, r.provider), log: join(tempDir(), `${r.run}-${r.provider}.jsonl`) }));
  const started = Date.now();
  const procs = runs.map((r) =>
    Bun.spawn(
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
        r.out,
        "--purpose",
        "diagnostic",
        "--replicates",
        "2",
        "--provider",
        r.provider,
        "--parallel",
        "12",
        "--judge-timeout-ms",
        "600000",
      ],
      {
        env: {
          ...process.env,
          PRBENCH_PREFLIGHT_CACHE: preflightCache,
          PRBENCH_CODEX_AUTH_HOME: auth,
          PRBENCH_CODEX_COMMAND: JSON.stringify([process.execPath, join(import.meta.dir, "fixtures", "fake-comparison-codex.ts")]),
          FAKE_CODEX_JUDGMENT: judgment,
          FAKE_CODEX_SPANS: r.log,
          FAKE_CODEX_DELAY_MS: "300",
          PRBENCH_CLAUDE_COMMAND: JSON.stringify([process.execPath, join(import.meta.dir, "fixtures", "fake-claude.ts")]),
          PRBENCH_CLAUDE_OAUTH_TOKEN: "synthetic-claude-token",
          FAKE_CLAUDE_MODE: "comparison",
          FAKE_CLAUDE_JUDGMENT: judgment,
          FAKE_CLAUDE_LOG: r.log,
          FAKE_CLAUDE_DELAY_MS: "300",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
  const results = await Promise.all(
    procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })),
  );
  const elapsed = Date.now() - started;
  for (const [i, r] of results.entries()) {
    const text = r.out + r.err;
    if (!existsSync(join(runs[i]!.out, "summary.json"))) console.error(runs[i]!.out, text.split("\n").filter((l) => !/^(codex exec|call |\[)/.test(l)).slice(-40).join("\n"));
    // A diagnostic run never passes the adoption gate; the controller exits with the summary's code.
    expect(r.code).toBe(JSON.parse(readFileSync(join(runs[i]!.out, "summary.json"), "utf8")).exitCode);
    expect(text).not.toMatch(/EMFILE|ENFILE|EEXIST|ENOTEMPTY|lock(ed)? (exists|file)|cannot lock ref|Timed out waiting|immutable cache entry/i);
  }
  for (const r of runs) {
    const summary = JSON.parse(readFileSync(join(r.out, "summary.json"), "utf8"));
    expect(summary.coverage.complete).toBe(true);
    expect(JSON.parse(readFileSync(join(r.out, "state.json"), "utf8")).status).toBe("complete");
    expect(existsSync(join(r.out, "controller.lock"))).toBe(false);
  }
  // Codex controllers really ran many jobs at once.
  expect(peakOverlap(runs[0]!.log)).toBeGreaterThanOrEqual(6);
  // One mirror, no stray temporary clones.
  expect(readdirSync(preflightCache).filter((n) => n.endsWith(".git"))).toHaveLength(1);
  expect(readdirSync(preflightCache).some((n) => n.endsWith(".tmp"))).toBe(false);
  // The shared login was never replaced, and every lease is gone.
  expect(readFileSync(join(auth, "auth.json"), "utf8")).toBe('{"synthetic":true}');
  expect(readdirSync(auth).filter((n) => n.endsWith(".lease") || n === "prbench.lock")).toEqual([]);
  console.log(`capacity smoke: 4 controllers x --parallel 12 in ${(elapsed / 1000).toFixed(1)} s`);
}, 900_000);
