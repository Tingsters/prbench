#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import {
  CaseError,
  caseDirs,
  loadCase,
  loadFacts,
  type Facts,
  type LoadedCase,
} from "./schema/case.ts";
import { checkArtifact, type PRArtifact } from "./schema/artifact.ts";
import { runCase } from "./run/runner.ts";
import { findSystem, SYSTEMS } from "./systems/index.ts";
import { DEFAULT_AGENT_OPTIONS, parseBudget } from "./systems/agentShared.ts";
import { judgePair, type PairResult } from "./judge/pairwise.ts";
import { parseJudge } from "./judge/providers.ts";
import { buildReport, reportMarkdown } from "./report.ts";
import { codexLogin } from "./agents/codexAuth.ts";
import { claudeAuthStatus, saveClaudeToken } from "./agents/claude.ts";
import { runBothProviders } from "./run/both.ts";
import { DEFAULT_CODEX_OPTIONS } from "./systems/codex.ts";
import { RUBRIC_VERSION } from "./judge/rubric.ts";
import { auditEvidence } from "./audit.ts";
import { version } from "../package.json";
import { compare, type CompareOptions } from "./compare.ts";
import { cleanupExperiment } from "./run/cleanup.ts";
import { experimentStatus } from "./run/status.ts";
import { preflight } from "./run/preflight.ts";
import { calibrateScope } from "./calibration.ts";
import { admission } from "./admission.ts";
import {
  datasetReleases,
  datasetRelease,
  defaultDataset,
  installDataset,
  resolveDatasetInputs,
} from "./datasets.ts";

const program = new Command("prbench")
  .version(version)
  .description(
    "Evaluate tools that write or change the pull requests AI coding agents produce.",
  );

function loadAll(root: string): { loaded: LoadedCase[]; errors: CaseError[] } {
  const loaded: LoadedCase[] = [];
  const errors: CaseError[] = [];
  for (const dir of caseDirs(root)) {
    try {
      loaded.push(loadCase(dir));
    } catch (err) {
      if (err instanceof CaseError) errors.push(err);
      else throw err;
    }
  }
  return { loaded, errors };
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const datasets = program
  .command("datasets")
  .description(
    "List and download versioned public case libraries without model calls",
  );
datasets.command("list").action(() => {
  for (const d of datasetReleases)
    console.log(
      `${d.id}@${d.version}  dev=${d.cases.dev.length} test=${d.cases.test.length}  ${d.description}`,
    );
});
datasets
  .command("fetch")
  .argument("[dataset]", "pinned dataset id@version", defaultDataset)
  .option(
    "--out <dir>",
    "install into a new directory instead of the shared cache",
  )
  .action(async (spec: string, opts: { out?: string }) => {
    const path = opts.out
      ? await installDataset(datasetRelease(spec), opts.out)
      : (await resolveDatasetInputs({ dataset: spec })).cases;
    console.log(
      `Dataset verified: ${spec}\nCases: ${path}\nPreparation: ${join(path, "preparation.json")}`,
    );
  });

program
  .command("calibrate-scope")
  .description(
    "Run fixed scope examples and optional retained development controls without writer calls",
  )
  .requiredOption("--out <dir>", "diagnostic output directory")
  .option("--historical <dir>", "retained historical calibration directory")
  .option(
    "--disputed-screen <dir>",
    "retained four-draft writer screen; paired with --historical",
  )
  .option("--plan", "describe fixed calls without launching judges")
  .option("--resume", "resume exact matching saved judgments")
  .option("--recover-lock", "recover only an owned exited controller")
  .action(async (opts) => {
    const result = await calibrateScope(opts);
    process.exitCode = result.exitCode;
    if (opts.plan) console.log(JSON.stringify(result, null, 2));
  });

program
  .command("admission")
  .description(
    "Run the fixed four-draft candidate admission screen after full scope calibration",
  )
  .requiredOption("--out <dir>", "admission output directory")
  .requiredOption(
    "--candidate-skill <dir>",
    "candidate skill and provenance-bound native runtime",
  )
  .requiredOption(
    "--cases <dir>",
    "development case root containing pr8 and pr9",
  )
  .requiredOption("--preparation <file>", "pinned preparation profile")
  .requiredOption("--calibration <dir>", "passing full calibration directory")
  .requiredOption(
    "--controls <dir>",
    "retained calibration inputs containing corrected controls",
  )
  .option("--plan", "describe fixed calls without running models")
  .option("--resume", "resume exact matching saved generations and judgments")
  .option("--recover-lock", "recover only an owned exited controller")
  .action(async (opts) => {
    const result = await admission(opts);
    process.exitCode = result.exitCode;
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("compare")
  .description(
    "Freeze and compare the provider's native agent, baseline Tracetoon and candidate Tracetoon",
  )
  .requiredOption(
    "--baseline-skill <dir>",
    "baseline skill with matching platform binary",
  )
  .requiredOption(
    "--candidate-skill <dir>",
    "candidate skill with matching platform binary",
  )
  .option("--cases <dir>", "local case directory")
  .option(
    "--dataset <id@version>",
    "public dataset; defaults to the pinned release when --cases is omitted",
  )
  .requiredOption("--out <dir>", "new experiment directory")
  .option("--split <split>", "dev or test", "dev")
  .option("--preparation <file>", "explicit per-case preparation profile")
  .option(
    "--development <dir>",
    "passing frozen dev experiment, required for test split",
  )
  .option("--prepare-only", "freeze inputs without launching writers or judges")
  .option(
    "--verify-only",
    "freeze inputs and run unscored skill isolation probes only",
  )
  .option("--resume", "resume only exact matching inputs and saved artifacts")
  .option(
    "--recover-lock",
    "with --resume, recover an owned lock only after its controller process has exited",
  )
  .option(
    "--replicates <n>",
    "predeclared samples per case/model/system",
    Number,
    3,
  )
  .option("--purpose <purpose>", "confirmation or diagnostic", "confirmation")
  .option("--cache <dir>", "content-addressed stage cache")
  .option(
    "--reuse-from <dir>",
    "retain an exact writer performance block after a facts or judge repair",
  )
  .option(
    "--plan",
    "preflight and explain scheduled calls and writer cache reuse",
  )
  .option(
    "--report-only",
    "rebuild a v2 report with no model calls; requires --resume",
  )
  .option("--timeout-ms <ms>", "explicit per-process hung-job timeout", Number)
  .option(
    "--provider <provider>",
    "codex (Codex writes and judges), claude (Claude Code writes and judges) or both (two independent runs in <out>/codex and <out>/claude)",
    "codex",
  )
  .option(
    "--parallel <n>",
    "concurrent writer/judge jobs per provider (1 keeps the serial order)",
    Number,
    4,
  )
  .option(
    "--models <ids>",
    "writer models (comma-separated), replacing the provider's defaults; the provider's judges stay the same",
    (v: string) =>
      v
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
  )
  .action(
    async (
      opts: Omit<CompareOptions, "cases"> & {
        cases?: string;
        dataset?: string;
      },
    ) => {
      if (opts.provider === "both" && opts.models?.length) {
        console.error(
          "--models names one provider's models; run --provider codex and --provider claude separately.",
        );
        process.exitCode = 2;
        return;
      }
      if (opts.provider === "both") {
        process.exitCode = await runBothProviders(process.argv.slice(2));
        return;
      }
      try {
        const inputs = await resolveDatasetInputs(opts);
        const result = await compare({ ...opts, ...inputs });
        if ("exitCode" in result) process.exitCode = result.exitCode;
      } catch (error) {
        console.error(String(error));
        process.exitCode = 2;
      }
    },
  );

program
  .command("cleanup")
  .requiredOption("--experiment <dir>", "experiment with owned pending cleanup")
  .action((opts: { experiment: string }) => {
    const result = cleanupExperiment(resolve(opts.experiment));
    console.log(JSON.stringify(result));
    if (result.pending) process.exitCode = 1;
  });

program
  .command("status")
  .requiredOption(
    "--experiment <dir>",
    "experiment to inspect without launching calls",
  )
  .action((opts: { experiment: string }) =>
    console.log(
      JSON.stringify(experimentStatus(resolve(opts.experiment)), null, 2),
    ),
  );
program
  .command("preflight")
  .option("--cases <dir>", "local case directory")
  .option(
    "--dataset <id@version>",
    "public dataset; defaults to the pinned release",
  )
  .option("--split <split>", "selected split", "dev")
  .option("--out <file>", "save evidence preview")
  .action(
    async (opts: {
      cases?: string;
      dataset?: string;
      split: string;
      out?: string;
    }) => {
      if (!["dev", "test"].includes(opts.split))
        throw new Error("Split must be dev or test.");
      if (opts.split === "test")
        throw new Error(
          "Held-out preflight runs only through compare after the development gate passes.",
        );
      const inputs = await resolveDatasetInputs(opts);
      const selected = caseDirs(resolve(inputs.cases))
        .map(loadCase)
        .filter((l) => l.case.split === opts.split && !l.case.excluded);
      const result = preflight(selected, {
        cache: resolve(
          import.meta.dir,
          "../node_modules/.cache/prbench-preflight",
        ),
        out: opts.out,
      });
      console.log(
        JSON.stringify(
          {
            ...result,
            cases: result.cases.map(
              ({ neutralEvidence: _privateEvidence, ...summary }) => summary,
            ),
          },
          null,
          2,
        ),
      );
    },
  );

program
  .command("auth")
  .description(
    "Set up the separate benchmark login: Codex signs in through the browser; Claude stores a `claude setup-token` token read from stdin",
  )
  .argument("<agent>", "codex or claude")
  .option("--status", "show the benchmark login status")
  .option(
    "--device-auth",
    "Codex: use device-code login instead of browser callback",
  )
  .action(
    async (agent: string, opts: { status?: boolean; deviceAuth?: boolean }) => {
      if (agent === "codex") {
        process.exitCode = codexLogin(opts.status, opts.deviceAuth);
        return;
      }
      if (agent !== "claude") throw new Error("Use codex or claude.");
      if (opts.status) {
        const status = claudeAuthStatus();
        console.log(
          status.ok
            ? `Benchmark Claude login: ${status.source}`
            : "No benchmark Claude login. Run `claude setup-token`, then pipe the token into `prbench auth claude`.",
        );
        process.exitCode = status.ok ? 0 : 1;
        return;
      }
      if (process.stdin.isTTY)
        console.error(
          "Paste the token printed by `claude setup-token`, then press Enter and Ctrl-D.",
        );
      const token = (await Bun.stdin.text()).trim();
      const file = saveClaudeToken(token);
      console.log(`Saved the benchmark Claude token to ${file} (mode 0600).`);
    },
  );

/** Runs `tasks` with at most `limit` in flight, reporting failures instead of stopping. */
async function pool<T>(
  limit: number,
  tasks: (() => Promise<T>)[],
): Promise<{ ok: T[]; failed: string[] }> {
  const ok: T[] = [];
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      try {
        ok.push(await task());
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return { ok, failed };
}

function readArtifacts(
  dir: string,
  caseId: string,
  systems: string[],
): Map<string, PRArtifact> {
  const out = new Map<string, PRArtifact>();
  for (const s of systems) {
    const p = join(dir, caseId, `${s}.json`);
    if (!existsSync(p)) continue;
    const a = JSON.parse(readFileSync(p, "utf8")) as PRArtifact;
    const problems = checkArtifact(a);
    if (problems.length)
      throw new Error(
        `${p} is not a valid artifact:\n  ${problems.join("\n  ")}`,
      );
    out.set(s, a);
  }
  return out;
}

program
  .command("validate")
  .description("Check every case under a cases directory")
  .argument("[cases]", "cases directory", "cases")
  .action((root: string) => {
    const { loaded, errors } = loadAll(resolve(root));
    for (const l of loaded) {
      console.log(
        `ok    ${l.case.id} (${l.case.mode}, ${l.case.split})${l.case.excluded ? ` excluded: ${l.case.excluded}` : ""}`,
      );
    }
    for (const e of errors) console.log(`FAIL  ${e.message}`);
    if (loaded.length + errors.length === 0) {
      console.log(`no cases found under ${root}`);
      process.exitCode = 1;
    }
    if (errors.length) process.exitCode = 1;
  });

program
  .command("systems")
  .description("List the systems that can be run")
  .action(() => {
    for (const s of SYSTEMS) console.log(`${s.id.padEnd(14)} ${s.description}`);
  });

program
  .command("run")
  .description(
    "Run a system on one case, or on every case it supports, and write PR artifacts",
  )
  .requiredOption("-s, --system <id>", "system to run")
  .option("-c, --case <ids>", "only these cases (comma-separated)")
  .option("--split <split>", "only cases in this split (dev or test)")
  .option("--cases <dir>", "cases directory", "cases")
  .option("-o, --out <dir>", "output directory", "results/artifacts")
  .option("--model <model>", "model (Claude: opus; Codex: gpt-6.1-sol)")
  .option(
    "--reasoning-effort <effort>",
    "Codex reasoning effort (default: medium)",
  )
  .option("--max-budget-usd <n>", "spending cap (Claude: 25; Codex: none)")
  .option(
    "--timeout-min <n>",
    "time limit per agent run, in minutes",
    String(DEFAULT_AGENT_OPTIONS.timeoutMs / 60_000),
  )
  .option(
    "--skip-existing",
    "skip cases that already have an artifact for this system",
  )
  .option("--keep-sandbox", "leave sandboxes on disk for inspection")
  .action(
    async (opts: {
      system: string;
      case?: string;
      split?: string;
      cases: string;
      out: string;
      model?: string;
      reasoningEffort?: string;
      maxBudgetUsd?: string;
      timeoutMin: string;
      skipExisting?: boolean;
      keepSandbox?: boolean;
    }) => {
      const defaults = opts.system.startsWith("codex-")
        ? DEFAULT_CODEX_OPTIONS
        : DEFAULT_AGENT_OPTIONS;
      const system = findSystem(opts.system, {
        model: opts.model ?? defaults.model,
        ...(opts.reasoningEffort
          ? { reasoningEffort: opts.reasoningEffort }
          : {}),
        maxBudgetUsd:
          opts.maxBudgetUsd === undefined
            ? defaults.maxBudgetUsd
            : parseBudget(opts.maxBudgetUsd),
        timeoutMs: Number(opts.timeoutMin) * 60_000,
      });
      const { loaded, errors } = loadAll(resolve(opts.cases));
      const wanted = opts.case ? list(opts.case) : undefined;
      let picked = wanted
        ? loaded.filter((l) => wanted.includes(l.case.id))
        : loaded;
      if (opts.split)
        picked = picked.filter((l) => l.case.split === opts.split);
      for (const id of wanted ?? []) {
        if (picked.some((l) => l.case.id === id)) continue;
        const broken = errors.find((e) => e.where.includes(id));
        throw new Error(
          broken ? broken.message : `no case "${id}" under ${opts.cases}`,
        );
      }
      let failures = 0;
      for (const l of picked) {
        if (l.case.excluded) {
          console.log(`skip  ${l.case.id}: excluded (${l.case.excluded})`);
          continue;
        }
        const support = system.supports(l);
        if (!support.supported) {
          console.log(`skip  ${l.case.id}: ${support.reason}`);
          continue;
        }
        if (
          opts.skipExisting &&
          existsSync(join(resolve(opts.out), l.case.id, `${system.id}.json`))
        ) {
          if (opts.system.startsWith("codex-")) {
            const existing = readArtifacts(resolve(opts.out), l.case.id, [
              system.id,
            ]).get(system.id)!;
            const effort =
              opts.reasoningEffort ?? DEFAULT_CODEX_OPTIONS.reasoningEffort;
            if (
              existing.meta.model !== (opts.model ?? defaults.model) ||
              existing.meta.reasoningEffort !== effort
            ) {
              throw new Error(
                `${l.case.id}/${system.id}: existing artifact has different model or reasoning settings; choose another --out directory.`,
              );
            }
          }
          console.log(`skip  ${l.case.id}: artifact exists`);
          continue;
        }
        try {
          const r = await runCase(l, system, {
            outDir: resolve(opts.out),
            keepSandbox: opts.keepSandbox,
            log: (m) => console.error(m),
          });
          const cost =
            r.artifact.meta.costUsd === undefined
              ? ""
              : ` $${r.artifact.meta.costUsd.toFixed(2)}`;
          console.log(
            `ok    ${l.case.id} -> ${r.path}${cost}${r.sandboxRoot ? ` (sandbox ${r.sandboxRoot})` : ""}`,
          );
        } catch (err) {
          failures++;
          console.log(
            `FAIL  ${l.case.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (failures) process.exitCode = 1;
    },
  );

program
  .command("judge")
  .description(
    "Judge every pair of systems on every case with artifacts, in both orders, then write the report",
  )
  .option(
    "--systems <ids>",
    "systems to compare, in report order",
    SYSTEMS.map((s) => s.id).join(","),
  )
  .option(
    "--judges <specs>",
    "judges: claude[:model], codex[:model], codex:model@effort",
    "claude,codex",
  )
  .option("--split <split>", "only cases in this split (dev or test)")
  .option("-c, --case <ids>", "only these cases (comma-separated)")
  .option("--cases <dir>", "cases directory", "cases")
  .option("--artifacts <dir>", "artifacts directory", "results/artifacts")
  .option("-o, --out <dir>", "results directory", "results")
  .option("-j, --jobs <n>", "judging calls in parallel", "3")
  .option("--force", "judge again even when a cached judgment matches")
  .action(
    async (opts: {
      systems: string;
      judges: string;
      split?: string;
      case?: string;
      cases: string;
      artifacts: string;
      out: string;
      jobs: string;
      force?: boolean;
    }) => {
      const existingPairs = join(resolve(opts.out), "pairs.json");
      const existingReport = join(resolve(opts.out), "report.json");
      const existingPlan = join(resolve(opts.out), "judging.json");
      if (
        (existsSync(existingPairs) &&
          (
            JSON.parse(readFileSync(existingPairs, "utf8")) as PairResult[]
          ).some((r) => r.rubricVersion !== RUBRIC_VERSION)) ||
        [existingReport, existingPlan].some(
          (p) =>
            existsSync(p) &&
            JSON.parse(readFileSync(p, "utf8")).rubricVersion !==
              RUBRIC_VERSION,
        )
      ) {
        throw new Error(
          "This output contains historical rubric results. Use a separate --out directory to preserve them.",
        );
      }
      const systems = list(opts.systems);
      const judges = list(opts.judges).map(parseJudge);
      const { loaded } = loadAll(resolve(opts.cases));
      const wanted = opts.case ? list(opts.case) : undefined;
      const selected = loaded.filter(
        (l) =>
          (!wanted || wanted.includes(l.case.id)) &&
          (!opts.split || l.case.split === opts.split),
      );
      const tasks: (() => Promise<PairResult>)[] = [];
      for (const l of selected) {
        if (l.case.excluded) {
          console.log(`skip  ${l.case.id}: excluded (${l.case.excluded})`);
          continue;
        }
        const facts = loadFacts(l);
        if (!facts) {
          console.log(`skip  ${l.case.id}: no fact sheet`);
          continue;
        }
        const arts = readArtifacts(resolve(opts.artifacts), l.case.id, systems);
        const present = systems.filter((s) => arts.has(s));
        if (present.length < 2) {
          console.log(
            `skip  ${l.case.id}: fewer than two systems have artifacts (${present.join(", ") || "none"})`,
          );
          continue;
        }
        for (let i = 0; i < present.length; i++) {
          for (let k = i + 1; k < present.length; k++) {
            for (const judge of judges) {
              tasks.push(async () => {
                const r = await judgePair({
                  loaded: l,
                  facts,
                  x: arts.get(present[i]!)!,
                  y: arts.get(present[k]!)!,
                  judge,
                  outDir: join(resolve(opts.out), "judgments"),
                  force: opts.force,
                });
                console.log(
                  `ok    ${r.case} ${r.x} vs ${r.y} [${r.judge}]: ${r.verdict}${r.flipped ? " (flipped)" : ""}`,
                );
                return r;
              });
            }
          }
        }
      }
      const { ok, failed } = await pool(Number(opts.jobs), tasks);
      for (const f of failed) console.log(`FAIL  ${f}`);
      mkdirSync(resolve(opts.out), { recursive: true });
      writeFileSync(
        join(resolve(opts.out), "pairs.json"),
        JSON.stringify(ok, null, 2) + "\n",
      );
      writeReport(
        ok,
        selected,
        resolve(opts.artifacts),
        systems,
        resolve(opts.out),
        judges.map((j) => j.id),
      );
      if (failed.length) process.exitCode = 1;
    },
  );

function writeReport(
  results: PairResult[],
  loaded: LoadedCase[],
  artifactsDir: string,
  systems: string[],
  out: string,
  judges?: string[],
): void {
  const planPath = join(out, "judging.json");
  if (judges)
    writeFileSync(
      planPath,
      JSON.stringify(
        {
          rubricVersion: RUBRIC_VERSION,
          judges,
          cases: loaded.map((l) => l.case.id),
          systems,
        },
        null,
        2,
      ) + "\n",
    );
  else if (existsSync(planPath)) {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      judges: string[];
      cases: string[];
      systems: string[];
    };
    judges = plan.judges;
    loaded = loaded.filter((l) => plan.cases.includes(l.case.id));
    systems = systems.filter((s) => plan.systems.includes(s));
  }
  const facts = new Map<string, Facts>();
  const artifacts = new Map<string, Map<string, PRArtifact>>();
  const splitOf = new Map<string, string>();
  for (const l of loaded) {
    if (l.case.excluded) continue;
    const arts = readArtifacts(artifactsDir, l.case.id, systems);
    if (arts.size < 2) continue;
    const f = loadFacts(l);
    if (!f) continue;
    facts.set(l.case.id, f);
    artifacts.set(l.case.id, arts);
    splitOf.set(l.case.id, l.case.split);
  }
  const report = buildReport({ results, judges, artifacts, facts, splitOf });
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  writeFileSync(join(out, "report.md"), reportMarkdown(report));
  console.log(`report: ${join(out, "report.md")}`);
}

program
  .command("report")
  .description("Rebuild the report from saved pair results")
  .option(
    "--systems <ids>",
    "systems, in report order",
    SYSTEMS.map((s) => s.id).join(","),
  )
  .option("--cases <dir>", "cases directory", "cases")
  .option("--artifacts <dir>", "artifacts directory", "results/artifacts")
  .option("-o, --out <dir>", "results directory", "results")
  .action(
    (opts: {
      systems: string;
      cases: string;
      artifacts: string;
      out: string;
    }) => {
      const results = JSON.parse(
        readFileSync(join(resolve(opts.out), "pairs.json"), "utf8"),
      ) as PairResult[];
      writeReport(
        results,
        loadAll(resolve(opts.cases)).loaded,
        resolve(opts.artifacts),
        list(opts.systems),
        resolve(opts.out),
      );
    },
  );

program
  .command("check-artifact")
  .description("Check that a file is a valid PR artifact")
  .argument("<file>")
  .action((file: string) => {
    const problems = checkArtifact(JSON.parse(readFileSync(file, "utf8")));
    if (problems.length) {
      console.log(`FAIL  ${file}\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    } else console.log(`ok    ${file}`);
  });

program
  .command("audit-evidence")
  .description(
    "Audit saved drafts and prepare immutable copies for v3 rejudging; never calls a model or reruns historical checks",
  )
  .requiredOption("--artifacts <dir>", "source artifacts directory")
  .requiredOption("-o, --out <dir>", "new audit directory (must be empty)")
  .option("--cases <dir>", "cases directory", "cases")
  .option("--split <split>", "audit only this split", "dev")
  .option(
    "--judgments <dir>",
    "historical judgments to inventory without changing verdicts",
  )
  .option(
    "--recovery-manifest <file>",
    "explicit artifact/log hash and repository mappings",
  )
  .action(
    (opts: {
      artifacts: string;
      out: string;
      cases: string;
      split: string;
      judgments?: string;
      recoveryManifest?: string;
    }) => {
      const audit = auditEvidence({
        artifactsDir: opts.artifacts,
        outDir: opts.out,
        casesDir: opts.cases,
        split: opts.split,
        judgmentsDir: opts.judgments,
        recoveryManifest: opts.recoveryManifest,
      });
      console.log(
        `Audited ${audit.artifacts.length} ${audit.split} artifacts; ${audit.artifacts.filter((a) => a.coverage === "unavailable").length} have unavailable fresh evidence. Report: ${join(resolve(opts.out), "audit.md")}`,
      );
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
