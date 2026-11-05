/** Frozen, stage-addressed experiments. Quality failure is a result, not a retry. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CompareOptions } from "./compare.ts";
import { operationSummary, assertResume } from "./compare.ts";
import {
  directoryDigest,
  runtimeIdentity,
  type Preparation,
  type RuntimeIdentity,
} from "./run/comparisonInputs.ts";
import {
  StageCache,
  canonical,
  implementationDigest,
  stageKey,
} from "./run/cache.ts";
import {
  atomicJson,
  failureKind,
  readEvents,
  recordEvent,
  retryDelay,
} from "./run/ledger.ts";
import { digest } from "./util/hash.ts";
import { experimentStatus } from "./run/status.ts";
import { preflight, writerCaseIdentity } from "./run/preflight.ts";
import {
  caseDirs,
  loadCase,
  loadFacts,
  type LoadedCase,
} from "./schema/case.ts";
import {
  artifactDigest,
  checkArtifact,
  type PRArtifact,
} from "./schema/artifact.ts";
import {
  codexCommand,
  codexRunEnv,
  codexAuthHome,
} from "./agents/codexAuth.ts";
import { PR_PROMPT } from "./systems/agentShared.ts";
import { runComparisonWriter } from "./run/comparisonWriter.ts";
import { assertWriterScope as assertScope } from "./run/scopeAudit.ts";
import { verifyComparisonIsolation } from "./run/isolation.ts";
import { judgePair, judgmentPath, type PairResult } from "./judge/pairwise.ts";
import { parseJudge } from "./judge/providers.ts";
import { RUBRIC_VERSION } from "./judge/rubric.ts";
import { buildReport, reportMarkdown } from "./report.ts";
import {
  qualityGate,
  accuracyFindings,
  adoptionGate,
  type Adjudication,
  type ComparisonReport,
} from "./gates.ts";
import { performanceReport, type WriterMetric } from "./performance.ts";
import { performanceEvidence } from "./validationWork.ts";
import { exec, git } from "./util/exec.ts";
import { redactEvidence } from "./agents/validation.ts";
import { setCancellationSignal } from "./run/cancellation.ts";
import { commandIdentity, ownerIdentity, harnessRevision } from "./run/identity.ts";
import { systemOrder, COMPARISON_SYSTEMS } from "./run/schedule.ts";
import { controllerLock } from "./run/controller.ts";
import {
  verifyValidationProof,
  type AdjudicationSource,
} from "./run/adjudication.ts";

const MODELS = ["gpt-6.1-sol", "gpt-6.1-terra"];
export const COMPARISON_WRITER_ENTRIES = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "src/run/comparisonWriter.ts",
  "src/run/writerInputs.ts",
  "src/run/isolation.ts",
  "src/agents/windows-job.cs",
  "src/run/fake-gh.ts",
  "src/run/schedule.ts",
];
const JUDGES = MODELS.map((model) => `codex:${model}@medium`);
const SYSTEMS = COMPARISON_SYSTEMS;
const read = <T = any>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8"));
interface Input {
  hash: string;
  identity: RuntimeIdentity;
  runtimeName: string;
}
export interface ComparisonManifest {
  schema: "prbench.comparison/v2";
  id: string;
  identity: string;
  split: string;
  baseline: Input;
  candidate: Input;
  cases: { id: string; hash: string; writerIdentity: string }[];
  writerContract: string;
  judgeContract: string;
  gatePolicyHash: string;
  preparationHash: string;
  probeCaseHash: string;
  settings: {
    models: string[];
    judges: string[];
    effort: string;
    timeoutMs: number;
    rubricVersion: number;
    replicates: number;
    purpose: string;
    cliVersion: string;
    agentCommandHash: string;
    promptHash: string;
    toolchain: {
      bun: string;
      node: string;
      platform: string;
      arch: string;
      environmentHash: string;
      authProfileHash: string;
      executableSha256: string;
      owner: string;
    };
  };
  performanceBlock: string;
  provenance: {
    harnessRevision: string | null;
    harnessHash: string;
    bun: string;
    at: string;
    harnessSnapshotHash?: string;
  };
}
const modelRoot = (root: string, replicate: number, model: string) =>
  replicate === 1
    ? join(root, model)
    : join(root, `replicate-${String(replicate).padStart(3, "0")}`, model);
function preparationKey(profile: Preparation | undefined, id: string) {
  const own = profile?.cases[id];
  return stageKey("preparation", {
    commands: own?.commands ?? [],
    fixtures: (own?.fixtures ?? []).map((f) => ({
      name: f.name,
      revision: f.revision,
      bundle: digest(readFileSync(f.bundle)),
    })),
  });
}
function absolutePreparation(
  profile: Preparation | undefined,
  source?: string,
): Preparation | undefined {
  if (!profile) return;
  const copy = structuredClone(profile);
  if (!copy.cases || typeof copy.cases !== "object")
    throw new Error("Preparation profile needs cases.");
  for (const entry of Object.values(copy.cases))
    for (const fixture of entry.fixtures ?? [])
      fixture.bundle = resolve(dirname(source!), fixture.bundle);
  return copy;
}
function verifyFrozen(root: string, manifest: ComparisonManifest) {
  if (manifest.provenance.harnessSnapshotHash)
    assertResume(
      manifest.provenance.harnessSnapshotHash,
      directoryDigest(join(root, "inputs", "harness")),
    );
  for (const name of ["baseline", "candidate"] as const)
    assertResume(
      manifest[name].hash,
      directoryDigest(join(root, "inputs", name)),
    );
  for (const c of manifest.cases)
    assertResume(c.hash, directoryDigest(join(root, "inputs", "cases", c.id)));
  assertResume(
    manifest.probeCaseHash,
    directoryDigest(join(root, "inputs", "isolation", "example-greet-default")),
  );
  const profile = existsSync(join(root, "inputs", "preparation.json"))
    ? read<Preparation>(join(root, "inputs", "preparation.json"))
    : undefined;
  assertResume(
    manifest.preparationHash,
    stageKey(
      "preparation-all",
      manifest.cases.map((c) => [c.id, preparationKey(profile, c.id)]),
    ),
  );
  return profile;
}
function writerKey(
  manifest: ComparisonManifest,
  profile: Preparation | undefined,
  c: ComparisonManifest["cases"][number],
  model: string,
  system: string,
  replicate: number,
  contentOnly = false,
) {
  return stageKey("writer", {
    contract: manifest.writerContract,
    case: c.writerIdentity,
    preparation: preparationKey(profile, c.id),
    model,
    effort: manifest.settings.effort,
    prompt: manifest.settings.promptHash,
    cli: manifest.settings.cliVersion,
    command: manifest.settings.agentCommandHash,
    timeout: manifest.settings.timeoutMs,
    toolchain: manifest.settings.toolchain,
    replicate,
    system,
    runtime:
      system === "codex-native"
        ? null
        : manifest[system === "tracetoon-baseline" ? "baseline" : "candidate"],
    performanceBlock: contentOnly ? null : manifest.performanceBlock,
  });
}
function sourceProof(
  loaded: LoadedCase,
  proof: AdjudicationSource,
  cache: string,
  artifact?: PRArtifact,
) {
  if (proof.kind === "validation") {
    if (!artifact)
      throw new Error(
        "Flagged artifact is unavailable for validation adjudication.",
      );
    verifyValidationProof(artifact, proof);
    return;
  }
  const bare = join(
    cache,
    `${digest(readFileSync(join(loaded.dir, loaded.case.repo.bundle!)))}.git`,
  );
  const gitSource = (args: string[]) => {
    const result = exec(["git", "--git-dir", bare, ...args]);
    if (result.code) throw new Error("Adjudication source cannot be verified.");
    return result.stdout;
  };
  let text: string;
  if (
    proof.kind === "session" &&
    loaded.case.sessions?.some((s) => s.file === proof.path)
  )
    text = readFileSync(join(loaded.dir, proof.path!), "utf8");
  else if (proof.kind === "diff")
    text = gitSource([
      "diff",
      "--no-ext-diff",
      loaded.case.repo.base,
      loaded.case.repo.head!,
    ]);
  else if (
    proof.kind === "commit" &&
    proof.revision &&
    /^[a-f0-9]{40}$/.test(proof.revision)
  ) {
    gitSource([
      "merge-base",
      "--is-ancestor",
      proof.revision,
      loaded.case.repo.head!,
    ]);
    text = gitSource(["show", "--no-patch", "--format=fuller", proof.revision]);
  } else if (
    proof.kind === "git" &&
    [loaded.case.repo.base, loaded.case.repo.head].includes(proof.revision) &&
    proof.path &&
    !proof.path.includes(":") &&
    !proof.path.split(/[\\/]/).includes("..")
  )
    text = gitSource(["show", `${proof.revision}:${proof.path}`]);
  else throw new Error("Invalid adjudication source.");
  if (
    digest(text) !== proof.sha256 ||
    !Number.isInteger(proof.startLine) ||
    !Number.isInteger(proof.endLine) ||
    proof.startLine < 1 ||
    proof.endLine < proof.startLine ||
    proof.endLine > text.split(/\r?\n/).length
  )
    throw new Error("Adjudication source hash/range is stale or invalid.");
}
export function rebuildComparison(
  root: string,
  manifest: ComparisonManifest,
  preflightCache: string,
) {
  const profile = verifyFrozen(root, manifest);
  if (manifest.settings.rubricVersion !== RUBRIC_VERSION)
    throw new Error(
      "Frozen rubric differs; preserve the experiment and use diagnostic replay into a new experiment.",
    );
  const loaded = manifest.cases.map((c) =>
    loadCase(join(root, "inputs", "cases", c.id)),
  );
  const allArtifacts = new Map<string, PRArtifact>(),
    metrics: WriterMetric[] = [],
    reports: ComparisonReport[] = [],
    allPairs: { model: string; replicate: number; pair: PairResult }[] = [];
  const missingOrderEvidence: string[] = [];
  for (
    let replicate = 1;
    replicate <= manifest.settings.replicates;
    replicate++
  )
    for (const model of MODELS) {
      const base = modelRoot(root, replicate, model);
      for (const l of loaded)
        for (const system of SYSTEMS) {
          const file = join(base, "artifacts", l.case.id, `${system}.json`);
          if (!existsSync(file)) continue;
          const artifact = read<PRArtifact>(file),
            receipt = read(file.replace(/\.json$/, ".receipt.json"));
          assertScope(artifact, file, manifest.id);
          if (
            checkArtifact(artifact).length ||
            artifact.system !== system ||
            artifact.case !== l.case.id ||
            artifact.meta.model !== model ||
            receipt.key !==
              writerKey(
                manifest,
                profile,
                manifest.cases.find((c) => c.id === l.case.id)!,
                model,
                system,
                replicate,
              ) ||
            receipt.digest !== artifactDigest(artifact) ||
            receipt.experiment !== manifest.id
          )
            throw new Error("Saved artifact identity is invalid.");
          allArtifacts.set(
            `${replicate}/${model}/${l.case.id}/${system}`,
            artifact,
          );
          const status = existsSync(file.replace(/\.json$/, ".status.json"))
            ? read(file.replace(/\.json$/, ".status.json"))
            : {};
          metrics.push({
            ...artifact.meta,
            ...performanceEvidence(artifact),
            model,
            case: l.case.id,
            system,
            replicate,
            cleanup: status.cleanup?.state ?? "unknown",
            validationCommands: artifact.validation?.commands.length ?? 0,
            commandsWithKnownDirectory:
              artifact.validation?.commands.filter(
                (c) => !c.cwd.startsWith("unknown"),
              ).length ?? 0,
            commandsWithKnownRevision:
              artifact.validation?.commands.filter((c) => c.before && c.after)
                .length ?? 0,
          });
        }
      for (const comparison of ["tracetoon-baseline", "codex-native"]) {
        const pairFile = join(base, comparison, "pairs.json");
        if (!existsSync(pairFile)) continue;
        const pairs = read<PairResult[]>(pairFile),
          artifacts = new Map<string, Map<string, PRArtifact>>();
        const pairIds = pairs.map((pair) => `${pair.case}/${pair.judge}`);
        if (
          new Set(pairIds).size !== pairs.length ||
          pairs.some(
            (pair) =>
              pair.x !== comparison ||
              pair.y !== "tracetoon-candidate" ||
              !JUDGES.includes(pair.judge) ||
              !loaded.some((l) => l.case.id === pair.case),
          )
        )
          throw new Error(
            "Pair results contain duplicate or unexpected samples.",
          );
        for (const pair of pairs)
          for (const order of ["ab", "ba"] as const) {
            const file = judgmentPath(
              join(base, comparison, "judgments"),
              pair.case,
              pair.judge,
              pair.x,
              pair.y,
              order,
            );
            if (!existsSync(file) || !pair.orderDigests?.[order])
              missingOrderEvidence.push(
                `${replicate}/${model}/${pair.case}/${pair.judge}/${comparison}/${order}`,
              );
            else if (digest(readFileSync(file)) !== pair.orderDigests[order])
              throw new Error(
                "Order judgment bytes changed after pair acceptance.",
              );
          }
        const facts = new Map(loaded.map((l) => [l.case.id, loadFacts(l)!])),
          splitOf = new Map(loaded.map((l) => [l.case.id, l.case.split]));
        for (const l of loaded) {
          const a = allArtifacts.get(
              `${replicate}/${model}/${l.case.id}/${comparison}`,
            ),
            b = allArtifacts.get(
              `${replicate}/${model}/${l.case.id}/tracetoon-candidate`,
            );
          if (a && b)
            artifacts.set(
              l.case.id,
              new Map([
                [comparison, a],
                ["tracetoon-candidate", b],
              ]),
            );
        }
        const report = buildReport({
          results: pairs,
          judges: JUDGES,
          artifacts,
          facts,
          splitOf,
        });
        atomicJson(join(base, comparison, "report.json"), report);
        writeFileSync(
          join(base, comparison, "report.md"),
          reportMarkdown(report),
        );
        reports.push({ model, replicate, comparison, report });
        allPairs.push(...pairs.map((pair) => ({ model, replicate, pair })));
      }
    }
  const expectedWriters =
    loaded.length *
    MODELS.length *
    SYSTEMS.length *
    manifest.settings.replicates;
  const expectedOrders =
    loaded.length *
    MODELS.length *
    2 *
    JUDGES.length *
    2 *
    manifest.settings.replicates;
  const orders = allPairs.length * 2;
  const complete =
    metrics.length === expectedWriters &&
    orders === expectedOrders &&
    !missingOrderEvidence.length &&
    reports.every(
      (r) => r.report.coverage.completed === r.report.coverage.expected,
    );
  const findings = accuracyFindings(allPairs, allArtifacts);
  atomicJson(join(root, "accuracy-findings.json"), {
    schema: "prbench.accuracy-findings/v1",
    experiment: manifest.id,
    findings,
  });
  const auditFile = join(root, "adjudications.json");
  const auditRaw = existsSync(auditFile)
    ? readFileSync(auditFile, "utf8")
    : undefined;
  let adjudications: Adjudication[] = [];
  if (auditRaw !== undefined) {
    const audit = JSON.parse(auditRaw);
    if (
      audit.schema !== "prbench.adjudications/v1" ||
      audit.experiment !== manifest.id ||
      !Array.isArray(audit.entries)
    )
      throw new Error("Invalid adjudication file.");
    adjudications = audit.entries;
    const seen = new Set<string>();
    for (const entry of adjudications) {
      const finding = findings.find((f) => f.id === entry.finding);
      if (
        !finding ||
        seen.has(entry.finding) ||
        !["confirmed", "false-positive", "unresolved"].includes(
          entry.outcome,
        ) ||
        !entry.reviewedBy?.trim() ||
        !Number.isFinite(Date.parse(entry.reviewedAt)) ||
        !entry.rationale?.trim() ||
        !entry.sources?.length
      )
        throw new Error(
          "Adjudication needs a known finding, reviewer, rationale and source proof.",
        );
      seen.add(entry.finding);
      for (const source of entry.sources)
        sourceProof(
          loaded.find((l) => l.case.id === finding.case)!,
          source,
          preflightCache,
          allArtifacts.get(
            `${finding.replicate}/${finding.model}/${finding.case}/tracetoon-candidate`,
          ),
        );
    }
  }
  const quality = qualityGate(
    reports,
    manifest.split,
    MODELS,
    findings,
    adjudications,
  );
  const performance = performanceReport(
    metrics,
    loaded.length * MODELS.length * manifest.settings.replicates,
    true,
  );
  const operations = experimentStatus(root);
  const adoption = adoptionGate({
    complete,
    purpose: manifest.settings.purpose,
    quality: quality.status,
    performance: performance.status,
    pendingCleanup: operations.pendingCleanup,
    writers: metrics,
    policyCurrent:
      manifest.gatePolicyHash ===
      implementationDigest(resolve(import.meta.dir, ".."), [
        "src/gates.ts",
        "src/performance.ts",
      ]),
  });
  const { status } = adoption;
  const summary = {
    schema: "prbench.comparison-report/v2",
    experiment: manifest.id,
    split: manifest.split,
    status,
    exitCode: adoption.exitCode,
    coverage: {
      writers: metrics.length,
      expectedWriters,
      orders,
      expectedOrders,
      missingOrderEvidence,
      complete,
    },
    qualityGate: quality,
    adjudicationSha256: auditRaw === undefined ? null : digest(auditRaw),
    performanceGate: performance,
    adoptionGate: adoption,
    reports,
    writerMetrics: metrics,
    operations: operationSummary(metrics),
    operationalHistory: operations,
    reportContract: implementationDigest(resolve(import.meta.dir, ".."), [
      "src/comparison.ts",
      "src/report.ts",
      "src/performance.ts",
      "src/gates.ts",
      "src/run/status.ts",
    ]),
    limitations: [
      `${manifest.settings.replicates} replicate(s) still represent ${loaded.length} independent cases in this split.`,
      "Writer timing includes service waits and neutral observation overhead; runtime diagnostics may overlap.",
      "Diagnostic reuse cannot establish a fresh performance improvement.",
      "Raw judgments are preserved separately from source-backed adjudications.",
    ],
  };
  const lines = [
    `# ${manifest.split} comparison`,
    "",
    `Outcome: **${status}**. Quality: ${quality.status}. Efficiency: ${performance.status}.`,
    "",
    `Writers: ${metrics.length}/${expectedWriters}; order judgments: ${orders}/${expectedOrders}.`,
    "",
    `Failed attempts: ${operations.failedAttempts}; failed-attempt time: ${Math.round(operations.failedAttemptMs / 1000)}s; current pending cleanup: ${operations.pendingCleanup}.`,
    "",
    "| Model | System | Samples | Median writer seconds | Median input tokens | Pending cleanup |",
    "|---|---|---:|---:|---:|---:|",
    ...summary.operations.map(
      (r) =>
        `| ${r.model} | ${r.system} | ${r.cases} | ${r.writerMedianMs === null ? "unknown" : (r.writerMedianMs / 1000).toFixed(2)} | ${r.inputTokenMedian ?? "unknown"} | ${r.pendingCleanup} |`,
    ),
    "",
    "## Gate findings",
    "",
    ...quality.failures.map((f) => `- ${f}`),
    ...performance.failures.map((f) => `- ${f}`),
    ...quality.unresolvedAccuracy.map((f) => `- Unresolved: ${f}`),
    "",
    "## Paired performance",
    "",
    `Candidate/baseline geometric mean writer ratio: ${performance.geometricMeanWriterRatio?.toFixed(3) ?? "unknown"}; case-clustered 95% interval: ${JSON.stringify(performance.writerRatio95CI)}.`,
    "",
    ...summary.limitations.map((x) => `- ${x}`),
    "",
    ...reports.map(
      (r) =>
        `## ${r.model}, replicate ${r.replicate}: ${r.comparison}\n\n${reportMarkdown(r.report)}`,
    ),
  ];
  const markdown = lines.join("\n") + "\n";
  const reportKey = stageKey("report", { summary, markdown });
  const reportCache = new StageCache(join(root, "derived-reports"));
  if (summary.adjudicationSha256)
    reportCache.put("adjudication", summary.adjudicationSha256, {
      raw: auditRaw,
    });
  reportCache.put("report", reportKey, {
    summary,
    markdown,
  });
  atomicJson(join(root, "summary.json"), { ...summary, reportKey });
  writeFileSync(join(root, "summary.md"), markdown);
  return summary;
}

export async function compareV2(opts: CompareOptions) {
  if (opts.recoverLock && !opts.resume)
    throw new Error("Lock recovery requires --resume.");
  const root = resolve(opts.out),
    harness = resolve(import.meta.dir, ".."),
    preflightCache = join(
      harness,
      "node_modules",
      ".cache",
      "prbench-preflight",
    );
  const old = existsSync(join(root, "manifest.json"))
    ? read<ComparisonManifest>(join(root, "manifest.json"))
    : undefined;
  if (old && old.schema !== "prbench.comparison/v2")
    throw new Error(
      "Legacy v1 experiments are read-only. Preserve them and start a v2 diagnostic experiment.",
    );
  if (opts.reportOnly) {
    if (!old || !opts.resume)
      throw new Error(
        "Report-only requires an existing v2 experiment and --resume.",
      );
    const release = controllerLock(root, old.id, opts.recoverLock);
    try {
      return rebuildComparison(root, old, preflightCache);
    } finally {
      release();
    }
  }
  if (!["dev", "test"].includes(opts.split))
    throw new Error("Comparison split must be dev or test.");
  const replicates = Number(opts.replicates ?? 3),
    purpose = opts.purpose ?? "confirmation";
  if (
    !Number.isSafeInteger(replicates) ||
    replicates < 1 ||
    !["diagnostic", "confirmation"].includes(purpose)
  )
    throw new Error(
      "Use positive integer replicates and purpose diagnostic or confirmation.",
    );
  if (purpose === "confirmation" && replicates !== 3)
    throw new Error(
      "The confirmation protocol predeclares exactly three replicates.",
    );
  if (opts.split === "test") {
    if (!opts.development)
      throw new Error("Held-out comparison requires --development.");
    const dev = read<ComparisonManifest>(
        join(opts.development, "manifest.json"),
      ),
      summary = rebuildComparison(
        resolve(opts.development),
        dev,
        preflightCache,
      );
    if (
      dev.schema !== "prbench.comparison/v2" ||
      dev.split !== "dev" ||
      summary.experiment !== dev.id ||
      !summary.adoptionGate?.passed
    )
      throw new Error(
        "Development adoption gate must pass before held-out inputs are opened.",
      );
  }
  const runtimeName = `tracetoon-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  const input = (dir: string, requireProvenance = false): Input => ({
    hash: directoryDigest(resolve(dir)),
    identity: runtimeIdentity(
      resolve(dir),
      join(resolve(dir), "bin", runtimeName),
      requireProvenance,
    ),
    runtimeName,
  });
  const baseline = input(opts.baselineSkill),
    candidate = input(opts.candidateSkill, purpose === "confirmation");
  const selected = caseDirs(resolve(opts.cases))
    .map(loadCase)
    .filter((l) => l.case.split === opts.split && !l.case.excluded);
  if (!selected.length) throw new Error("No eligible comparison cases.");
  const profile = absolutePreparation(
    opts.preparation ? read<Preparation>(resolve(opts.preparation)) : undefined,
    opts.preparation,
  );
  const cli = exec([...codexCommand(), "--version"]);
  if (cli.code) throw new Error("Codex CLI unavailable.");
  const common = ["package.json", "bun.lock", "tsconfig.json"];
  const writerEntries = COMPARISON_WRITER_ENTRIES;
  const writerContract = implementationDigest(harness, writerEntries);
  const judgeEntries = [
    ...common,
    "src/judge/pairwise.ts",
    "src/agents/windows-job.cs",
  ];
  const judgeContract = implementationDigest(harness, judgeEntries);
  const stable = {
    schema: "prbench.comparison/v2" as const,
    split: opts.split,
    baseline,
    candidate,
    cases: selected.map((l) => ({
      id: l.case.id,
      hash: directoryDigest(l.dir),
      writerIdentity: writerCaseIdentity(l),
    })),
    writerContract,
    judgeContract,
    gatePolicyHash: implementationDigest(harness, [
      "src/gates.ts",
      "src/performance.ts",
    ]),
    preparationHash: stageKey(
      "preparation-all",
      selected.map((l) => [l.case.id, preparationKey(profile, l.case.id)]),
    ),
    probeCaseHash: directoryDigest(
      join(harness, "cases", "example-greet-default"),
    ),
    settings: {
      models: MODELS,
      judges: JUDGES,
      effort: "medium",
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
      rubricVersion: RUBRIC_VERSION,
      replicates,
      purpose,
      cliVersion: cli.stdout.trim(),
      agentCommandHash: commandIdentity(codexCommand(), harness),
      promptHash: digest(PR_PROMPT),
      toolchain: {
        bun: Bun.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        environmentHash: stageKey(
          "writer-environment",
          Object.fromEntries(
            Object.entries(codexRunEnv(process.env)).filter(
              ([key]) =>
                ![
                  "CODEX_HOME",
                  "HOME",
                  "USERPROFILE",
                  "APPDATA",
                  "LOCALAPPDATA",
                  "XDG_CONFIG_HOME",
                  "XDG_DATA_HOME",
                  "FAKE_CODEX_JUDGMENT",
                  "FAKE_CODEX_SKIP_OUTPUT_FILE",
                ].includes(key.toUpperCase()),
            ),
          ),
        ),
        authProfileHash: digest(codexAuthHome()),
        executableSha256: digest(readFileSync(process.execPath)),
        owner: ownerIdentity(),
      },
    },
    performanceBlock: old?.performanceBlock ?? randomUUID(),
  };
  let reuse:
    | {
        root: string;
        manifest: ComparisonManifest;
        profile: Preparation | undefined;
      }
    | undefined;
  if (opts.reuseFrom) {
    if (old || opts.split !== "dev")
      throw new Error(
        "Writer-block reuse requires a new development experiment.",
      );
    const sourceRoot = resolve(opts.reuseFrom),
      source = read<ComparisonManifest>(join(sourceRoot, "manifest.json"));
    if (
      source.schema !== "prbench.comparison/v2" ||
      source.split !== "dev" ||
      existsSync(join(sourceRoot, "controller.lock"))
    )
      throw new Error(
        "Reuse source must be an inactive v2 development experiment.",
      );
    const sourceProfile = verifyFrozen(sourceRoot, source);
    const controls = (m: typeof stable | ComparisonManifest) => ({
      baseline: m.baseline,
      candidate: m.candidate,
      writerContract: m.writerContract,
      gatePolicyHash: m.gatePolicyHash,
      cases: m.cases.map((c) => [c.id, c.writerIdentity]),
      preparationHash: m.preparationHash,
      probeCaseHash: m.probeCaseHash,
      settings: { ...m.settings, judges: undefined, rubricVersion: undefined },
    });
    assertResume(controls(source), controls(stable));
    stable.performanceBlock = source.performanceBlock;
    reuse = { root: sourceRoot, manifest: source, profile: sourceProfile };
  }
  if (opts.split === "test") {
    const dev = read<ComparisonManifest>(
      join(opts.development!, "manifest.json"),
    );
    assertResume(
      [
        dev.baseline,
        dev.candidate,
        dev.writerContract,
        dev.judgeContract,
        dev.settings,
      ],
      [baseline, candidate, writerContract, judgeContract, stable.settings],
    );
  }
  const identity = stageKey("comparison", stable);
  if (old) {
    if (!opts.resume) throw new Error("Experiment exists; use --resume.");
    assertResume(old.identity, identity);
  }
  const cache = new StageCache(
    resolve(opts.cache ?? join(dirname(root), ".prbench-cache", "v2")),
  );
  const planned = {
    writers: selected.length * MODELS.length * SYSTEMS.length * replicates,
    orders:
      selected.length * MODELS.length * 2 * JUDGES.length * 2 * replicates,
  };
  if (opts.plan) {
    const preview = preflight(selected, { cache: preflightCache });
    const provisional: ComparisonManifest = {
      ...stable,
      id: identity,
      identity,
      provenance: {
        harnessRevision: harnessRevision(harness),
        harnessHash: directoryDigest(join(harness, "src")),
        bun: Bun.version,
        at: new Date().toISOString(),
      },
    };
    const jobs = selected.flatMap((c) =>
      MODELS.flatMap((model) =>
        Array.from({ length: replicates }, (_, i) =>
          SYSTEMS.map((system) => {
            const content = writerKey(
              provisional,
              profile,
              provisional.cases.find((v) => v.id === c.case.id)!,
              model,
              system,
              i + 1,
              true,
            );
            const cached =
              purpose === "diagnostic"
                ? cache.get<{ key: string }>("writer-content", content)
                : undefined;
            return {
              case: c.case.id,
              model,
              system,
              replicate: i + 1,
              reuse: !!cached,
              reason: cached
                ? "exact writer contract/input sample available"
                : purpose === "confirmation"
                  ? "fresh paired performance block"
                  : "no matching writer contract/input sample",
            };
          }),
        ).flat(),
      ),
    );
    const plan = {
      schema: "prbench.comparison-plan/v2",
      ...planned,
      purpose,
      replicates,
      writerContract,
      judgeContract,
      preflight: preview.cases.map((c) => ({
        case: c.case,
        checkedFacts: c.checkedFacts,
      })),
      jobs,
    };
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  if (!old) {
    if (existsSync(root) && readdirSync(root).length)
      throw new Error("New experiment output must be empty.");
    mkdirSync(join(root, "inputs", "cases"), { recursive: true });
    cpSync(resolve(opts.baselineSkill), join(root, "inputs", "baseline"), {
      recursive: true,
    });
    cpSync(resolve(opts.candidateSkill), join(root, "inputs", "candidate"), {
      recursive: true,
    });
    for (const l of selected)
      cpSync(l.dir, join(root, "inputs", "cases", l.case.id), {
        recursive: true,
      });
    cpSync(
      join(harness, "cases", "example-greet-default"),
      join(root, "inputs", "isolation", "example-greet-default"),
      { recursive: true },
    );
    if (profile) {
      const frozen = structuredClone(profile);
      for (const entry of Object.values(frozen.cases))
        for (const fixture of entry.fixtures ?? []) {
          const target = join(
            root,
            "inputs",
            "fixtures",
            `${digest(readFileSync(fixture.bundle))}.bundle`,
          );
          mkdirSync(dirname(target), { recursive: true });
          cpSync(fixture.bundle, target);
          fixture.bundle = target;
        }
      atomicJson(join(root, "inputs", "preparation.json"), frozen);
    }
    const harnessSnapshot = join(root, "inputs", "harness");
    mkdirSync(harnessSnapshot, { recursive: true });
    cpSync(join(harness, "src"), join(harnessSnapshot, "src"), {
      recursive: true,
    });
    for (const file of common)
      cpSync(join(harness, file), join(harnessSnapshot, file));
    assertResume(
      writerContract,
      implementationDigest(harnessSnapshot, writerEntries),
    );
    assertResume(
      judgeContract,
      implementationDigest(harnessSnapshot, judgeEntries),
    );
    atomicJson(join(root, "manifest.json"), {
      ...stable,
      id: identity,
      identity,
      provenance: {
        harnessRevision: harnessRevision(harness),
        harnessHash: directoryDigest(join(harness, "src")),
        harnessSnapshotHash: directoryDigest(harnessSnapshot),
        bun: Bun.version,
        at: new Date().toISOString(),
      },
    });
  }
  const manifest = read<ComparisonManifest>(join(root, "manifest.json")),
    frozenProfile = verifyFrozen(root, manifest);
  if (reuse) {
    for (let replicate = 1; replicate <= replicates; replicate++)
      for (const model of MODELS)
        for (const c of manifest.cases)
          for (const system of SYSTEMS) {
            const file = join(
              modelRoot(reuse.root, replicate, model),
              "artifacts",
              c.id,
              `${system}.json`,
            );
            if (!existsSync(file)) continue;
            const artifact = read<PRArtifact>(file),
              receipt = read(file.replace(/\.json$/, ".receipt.json"));
            const key = writerKey(
              manifest,
              frozenProfile,
              c,
              model,
              system,
              replicate,
            );
            assertScope(artifact, file, reuse.manifest.id);
            if (
              checkArtifact(artifact).length ||
              artifact.case !== c.id ||
              artifact.system !== system ||
              artifact.meta.model !== model ||
              receipt.key !== key ||
              receipt.digest !== artifactDigest(artifact) ||
              receipt.experiment !== reuse.manifest.id
            )
              throw new Error("Reuse source writer receipt is invalid.");
            if (!cache.get("writer", key))
              cache.put("writer", key, {
                artifact,
                status: read(file.replace(/\.json$/, ".status.json")),
              });
          }
    recordEvent(root, {
      stage: "writer-block",
      key: manifest.performanceBlock,
      kind: "reused",
      detail: `Retained writer block from ${reuse.manifest.id}; facts and judges are separately keyed.`,
    });
  }
  const loaded = manifest.cases.map((c) =>
    loadCase(join(root, "inputs", "cases", c.id)),
  );
  preflight(loaded, {
    cache: preflightCache,
    out: join(root, "preflight.json"),
  });
  if (opts.prepareOnly) return { status: "prepared", exitCode: 0, planned };
  const release = controllerLock(root, manifest.id, opts.recoverLock);
  const controller = new AbortController(),
    restoreSignal = setCancellationSignal(controller.signal);
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let active = "preflight",
    finishedWriters = 0,
    finishedOrders = 0,
    newWriterCalls = 0,
    newJudgeCalls = 0,
    reusedWriters = 0,
    reusedOrders = 0;
  const update = (status = "running", extra: Record<string, unknown> = {}) =>
    atomicJson(join(root, "state.json"), {
      schema: "prbench.experiment-state/v2",
      status,
      pid: process.pid,
      active,
      finishedWriters,
      finishedOrders,
      newWriterCalls,
      newJudgeCalls,
      reusedWriters,
      reusedOrders,
      planned,
      at: new Date().toISOString(),
      ...extra,
    });
  const heartbeat = setInterval(() => {
    update();
    console.error(
      `[progress] ${finishedWriters}/${planned.writers} writers; ${finishedOrders}/${planned.orders} order judgments; ${active}`,
    );
  }, 30000);
  try {
    update();
    await verifyComparisonIsolation({
      root,
      experiment: manifest.id,
      probeCase: join(root, "inputs", "isolation", "example-greet-default"),
      models: MODELS,
      variants: SYSTEMS.map((system) => {
        const which =
            system === "tracetoon-baseline" ? "baseline" : "candidate",
          skill = join(root, "inputs", which);
        return {
          system,
          ...(system === "codex-native"
            ? {}
            : { pinned: { skill, runtime: join(skill, "bin", runtimeName) } }),
        };
      }),
    });
    if (opts.verifyOnly) {
      update("verified");
      return { status: "verified", exitCode: 0 };
    }
    for (let replicate = 1; replicate <= replicates; replicate++)
      for (const [modelIndex, model] of MODELS.entries()) {
        const base = modelRoot(root, replicate, model),
          arts = new Map<string, Map<string, PRArtifact>>();
        for (const [caseIndex, l] of loaded.entries()) {
          const order = systemOrder(modelIndex, caseIndex, replicate),
            group = new Map<string, PRArtifact>();
          arts.set(l.case.id, group);
          for (const system of order) {
            if (controller.signal.aborted)
              throw new Error("Comparison cancelled.");
            active = `writer r${replicate} ${model}/${l.case.id}/${system}`;
            update();
            assertResume(
              manifest.settings.cliVersion,
              exec([...codexCommand(), "--version"]).stdout.trim(),
            );
            const c = manifest.cases.find((c) => c.id === l.case.id)!,
              key = writerKey(
                manifest,
                frozenProfile,
                c,
                model,
                system,
                replicate,
              ),
              content = writerKey(
                manifest,
                frozenProfile,
                c,
                model,
                system,
                replicate,
                true,
              );
            const file = join(base, "artifacts", l.case.id, `${system}.json`),
              receiptFile = file.replace(/\.json$/, ".receipt.json");
            let artifact: PRArtifact;
            if (existsSync(file)) {
              artifact = read(file);
              assertScope(artifact, file, manifest.id);
              reusedWriters++;
              if (!existsSync(receiptFile)) {
                const committed = cache.get<{ artifact: PRArtifact }>(
                  "writer",
                  key,
                );
                if (
                  !committed ||
                  artifactDigest(committed.artifact) !==
                    artifactDigest(artifact)
                )
                  throw new Error(
                    "Orphaned artifact has no committed cache receipt; preserve it for recovery.",
                  );
                atomicJson(receiptFile, {
                  experiment: manifest.id,
                  key,
                  digest: artifactDigest(artifact),
                });
                recordEvent(root, {
                  stage: "writer",
                  key,
                  kind: "recovered",
                  artifact: file,
                });
              }
              assertResume(read(receiptFile), {
                experiment: manifest.id,
                key,
                digest: artifactDigest(artifact),
              });
              recordEvent(root, {
                stage: "writer",
                key,
                kind: "reused",
                artifact: file,
              });
            } else {
              const pointer =
                purpose === "diagnostic"
                  ? cache.get<{ key: string }>("writer-content", content)
                  : undefined;
              const reused =
                cache.get<{ artifact: PRArtifact; status: unknown }>(
                  "writer",
                  key,
                ) ??
                (pointer
                  ? cache.get<{ artifact: PRArtifact; status: unknown }>(
                      "writer",
                      pointer.key,
                    )
                  : undefined);
              if (reused) {
                reusedWriters++;
                artifact = reused.artifact;
                assertScope(artifact, file, manifest.id);
                atomicJson(file, reused.artifact);
                atomicJson(file.replace(/\.json$/, ".status.json"), {
                  artifact: "saved",
                  cleanup: { state: "reused" },
                  origin: pointer?.key ?? key,
                });
                recordEvent(root, {
                  stage: "writer",
                  key,
                  kind: "reused",
                  artifact: file,
                });
              } else {
                const attemptRoot = join(root, "attempts", "writer", key);
                mkdirSync(attemptRoot, { recursive: true });
                const prior = readdirSync(attemptRoot).filter((name) =>
                  /^\d{3}$/.test(name),
                );
                let accepted: PRArtifact | undefined;
                for (let attempt = prior.length + 1; attempt <= 3; attempt++) {
                  const dir = join(
                    attemptRoot,
                    String(attempt).padStart(3, "0"),
                  );
                  mkdirSync(dir);
                  newWriterCalls++;
                  console.log(`call ${active}, attempt ${attempt}`);
                  update();
                  recordEvent(root, {
                    stage: "writer",
                    key,
                    kind: "started",
                    attempt,
                  });
                  const started = performance.now();
                  try {
                    assertResume(
                      writerContract,
                      implementationDigest(harness, writerEntries),
                    );
                    assertResume(
                      manifest.settings.agentCommandHash,
                      commandIdentity(codexCommand(), harness),
                    );
                    const which =
                        system === "tracetoon-baseline"
                          ? "baseline"
                          : "candidate",
                      skill = join(root, "inputs", which),
                      runtime = join(skill, "bin", runtimeName);
                    if (system !== "codex-native")
                      assertResume(
                        manifest[which].identity,
                        runtimeIdentity(skill, runtime),
                      );
                    const result = await runComparisonWriter({
                      loaded: l,
                      model,
                      system,
                      skill,
                      runtime,
                      timeoutMs: manifest.settings.timeoutMs,
                      out: dir,
                      preparation: frozenProfile,
                      ledgerRoot: root,
                    });
                    const value = result.artifact;
                    assertResume(
                      writerContract,
                      implementationDigest(harness, writerEntries),
                    );
                    if (
                      value.meta.writerOutcome?.isError ||
                      value.meta.writerOutcome?.timedOut
                    )
                      throw new Error(
                        `Writer invocation failed; available draft retained as diagnostic evidence. ${(value.meta.notes ?? []).join("; ")}`,
                      );
                    value.meta.experimentId = manifest.id;
                    if (system !== "codex-native") {
                      assertResume(
                        manifest[which].hash,
                        directoryDigest(skill),
                      );
                      value.meta.runtimeIdentity = manifest[which].identity;
                    }
                    const status = join(
                      dir,
                      l.case.id,
                      `${system}.status.json`,
                    );
                    if (existsSync(status))
                      cpSync(status, file.replace(/\.json$/, ".status.json"));
                    if (
                      checkArtifact(value).length ||
                      value.case !== l.case.id ||
                      value.system !== system ||
                      value.meta.model !== model
                    )
                      throw new Error(
                        "Generated artifact identity is invalid.",
                      );
                    // A completed generation survives a later audit rejection. Every
                    // consumer must still pass the current audit before accepting it.
                    cache.put("writer", key, {
                      artifact: value,
                      status: existsSync(status) ? read(status) : null,
                    });
                    assertScope(value, file, manifest.id);
                    accepted = value;
                    if (!cache.get("writer-content", content))
                      cache.putIfAbsent("writer-content", content, { key });
                    atomicJson(file, value);
                    recordEvent(root, {
                      stage: "writer",
                      key,
                      kind: "accepted",
                      attempt,
                      durationMs: performance.now() - started,
                      artifact: file,
                    });
                    break;
                  } catch (error) {
                    const kind = failureKind(error),
                      detail = redactEvidence(String(error));
                    atomicJson(join(dir, "failure.json"), {
                      failureKind: kind,
                      detail,
                      durationMs: performance.now() - started,
                    });
                    recordEvent(root, {
                      stage: "writer",
                      key,
                      kind: "failed",
                      attempt,
                      failureKind: kind,
                      detail,
                      durationMs: performance.now() - started,
                    });
                    if (
                      controller.signal.aborted ||
                      kind !== "transient" ||
                      attempt === 3
                    )
                      throw error;
                    await Bun.sleep(
                      retryDelay(error, attempt === 1 ? 10000 : 30000),
                    );
                  }
                }
                if (!accepted)
                  throw new Error(
                    `Writer attempt limit exhausted for ${l.case.id}/${system}. Completed work is preserved.`,
                  );
                artifact = accepted;
              }
              atomicJson(receiptFile, {
                experiment: manifest.id,
                key,
                digest: artifactDigest(artifact),
              });
            }
            if (
              checkArtifact(artifact).length ||
              artifact.system !== system ||
              artifact.case !== l.case.id
            )
              throw new Error("Saved artifact identity is invalid.");
            assertScope(artifact, file, manifest.id);
            group.set(system, artifact);
            finishedWriters++;
            update();
          }
        }
        for (const comparison of ["tracetoon-baseline", "codex-native"]) {
          const pairs: PairResult[] = [],
            out = join(base, comparison);
          for (const l of loaded)
            for (const judge of JUDGES) {
              if (controller.signal.aborted)
                throw new Error("Comparison cancelled.");
              active = `judge r${replicate} ${model}/${l.case.id}/${comparison}/${judge}`;
              update();
              const group = arts.get(l.case.id)!;
              const provider = parseJudge(judge),
                observed = {
                  ...provider,
                  ask: async (prompt: string) => {
                    assertResume(
                      judgeContract,
                      implementationDigest(harness, judgeEntries),
                    );
                    assertResume(
                      manifest.settings.agentCommandHash,
                      commandIdentity(codexCommand(), harness),
                    );
                    newJudgeCalls++;
                    console.log(`call ${active}`);
                    update();
                    const reply = await provider.ask(prompt);
                    assertResume(
                      judgeContract,
                      implementationDigest(harness, judgeEntries),
                    );
                    return reply;
                  },
                };
              pairs.push(
                await judgePair({
                  loaded: l,
                  facts: loadFacts(l)!,
                  x: group.get(comparison)!,
                  y: group.get("tracetoon-candidate")!,
                  judge: observed,
                  outDir: join(out, "judgments"),
                  controls: {
                    cache,
                    contract: judgeContract,
                    ledgerRoot: root,
                    onEvent: (kind) => {
                      if (kind === "reused") reusedOrders++;
                    },
                  },
                }),
              );
              atomicJson(join(out, "pairs.json"), pairs);
              finishedOrders += 2;
              update();
            }
        }
      }
    active = "report";
    const summary = rebuildComparison(root, manifest, preflightCache);
    update("complete", { outcome: summary.status, exitCode: summary.exitCode });
    return summary;
  } catch (error) {
    update(controller.signal.aborted ? "cancelled" : "invalid", {
      failureKind: controller.signal.aborted ? "cancelled" : failureKind(error),
      detail: redactEvidence(String(error)),
    });
    try {
      rebuildComparison(root, manifest, preflightCache);
    } catch {
      /* Preserve the primary failure. */
    }
    if (controller.signal.aborted)
      return { status: "cancelled", exitCode: 130 };
    throw error;
  } finally {
    clearInterval(heartbeat);
    restoreSignal();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    release();
  }
}
