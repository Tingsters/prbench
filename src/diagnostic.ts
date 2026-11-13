/** Fixed, judge-only diagnostic stages with the same durable recovery as comparison. */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  artifactDigest,
  checkArtifact,
  type PRArtifact,
} from "./schema/artifact.ts";
import type { Facts, LoadedCase } from "./schema/case.ts";
import type { ClaimAssessment } from "./judge/rubric.ts";
import { RUBRIC_VERSION } from "./judge/rubric.ts";
import { judgePair, judgmentPath, type PairResult } from "./judge/pairwise.ts";
import { parseJudge, type JudgeProvider } from "./judge/providers.ts";
import {
  StageCache,
  implementationDigest,
  stageKey,
  canonical,
} from "./run/cache.ts";
import { digest } from "./util/hash.ts";
import { directoryDigest } from "./run/comparisonInputs.ts";
import { controllerLock } from "./run/controller.ts";
import { atomicJson, recordEvent } from "./run/ledger.ts";
import { experimentStatus } from "./run/status.ts";
import { codexCommand } from "./agents/codexAuth.ts";
import { commandIdentity } from "./run/identity.ts";
import { setCancellationSignal } from "./run/cancellation.ts";
import { redactEvidence } from "./agents/validation.ts";
import { preflight } from "./run/preflight.ts";

export const DIAGNOSTIC_JUDGES = ["gpt-6.1-sol", "gpt-6.1-terra"].map(
  (m) => `codex:${m}@medium`,
);
export interface DiagnosticTask {
  id: string;
  phase: string;
  loaded: LoadedCase;
  facts: Facts;
  x: PRArtifact;
  y: PRArtifact;
  expected: {
    system: string;
    claim: string;
    statuses: ClaimAssessment["status"][];
  }[];
  /** Retain every flag; only these systems' unselected flags gate this task. */
  accuracySystems?: string[];
}
export interface DiagnosticOptions {
  out: string;
  resume?: boolean;
  plan?: boolean;
  recoverLock?: boolean;
}
const harness = resolve(import.meta.dir, "..");
export const JUDGE_ENTRIES = [
  "src/judge/pairwise.ts",
  "src/agents/windows-job.cs",
  "package.json",
  "bun.lock",
  "tsconfig.json",
];

export function diagnosticAssessment(task: DiagnosticTask, pair: PairResult) {
  const mismatches: string[] = [],
    unresolved: string[] = [],
    additionalFindings: string[] = [];
  for (const target of task.expected) {
    const sides = pair.sides[target.system] ?? [];
    if (sides.length !== 2)
      mismatches.push(
        `${task.id}/${pair.judge}/${target.system}: missing A/B coverage`,
      );
    for (const [order, side] of sides.entries()) {
      const selected = side.claimAssessments.filter(
        (a) => a.claim === target.claim,
      );
      if (
        selected.length !== 1 ||
        !target.statuses.includes(selected[0]!.status)
      )
        mismatches.push(
          `${task.id}/${pair.judge}/${order}: ${target.claim}: ${selected.map((a) => a.status).join(",") || "missing"}`,
        );
    }
  }
  for (const [system, sides] of Object.entries(pair.sides))
    for (const side of sides)
      for (const a of side.claimAssessments)
        if (
          ["contradicted", "unsupported"].includes(a.status) &&
          !task.expected.some(
            (e) =>
              e.system === system &&
              (e.claim === a.claim || a.claim.includes(e.claim)) &&
              e.statuses.includes(a.status),
          )
        ) {
          const finding = `${task.id}/${pair.judge}/${system}: ${a.claim}`;
          additionalFindings.push(finding);
          if (!task.accuracySystems || task.accuracySystems.includes(system))
            unresolved.push(finding);
        }
  return {
    mismatches,
    unresolved: [...new Set(unresolved)],
    additionalFindings: [...new Set(additionalFindings)],
  };
}

export async function runDiagnostic(
  opts: DiagnosticOptions & {
    kind: string;
    tasks: DiagnosticTask[];
    judges?: JudgeProvider[];
  },
) {
  if (opts.recoverLock && !opts.resume)
    throw Error("Lock recovery requires --resume.");
  const root = resolve(opts.out),
    providers = opts.judges ?? DIAGNOSTIC_JUDGES.map(parseJudge);
  if (
    !opts.tasks.length ||
    new Set(opts.tasks.map((t) => t.id)).size !== opts.tasks.length
  )
    throw Error("Diagnostic tasks require distinct nonempty ids.");
  for (const task of opts.tasks) {
    if (!/^[a-z0-9-]+$/.test(task.id) || task.loaded.case.split !== "dev")
      throw Error("Diagnostics accept named development cases only.");
    for (const artifact of [task.x, task.y])
      if (
        checkArtifact(artifact).length ||
        artifact.case !== task.loaded.case.id
      )
        throw Error("Diagnostic artifact identity is invalid.");
    if (task.x.system === task.y.system)
      throw Error("Diagnostic systems must be distinct.");
    for (const expected of task.expected) {
      const artifact = [task.x, task.y].find(
        (a) => a.system === expected.system,
      );
      if (!artifact?.body.includes(expected.claim) || !expected.statuses.length)
        throw Error("Expected diagnostic clause is absent from its artifact.");
    }
  }
  const contract = implementationDigest(harness, JUDGE_ENTRIES);
  const effective = {
    schema: "prbench.diagnostic/v1",
    kind: opts.kind,
    rubricVersion: RUBRIC_VERSION,
    contract,
    controllerContract: digest(readFileSync(import.meta.path)),
    command: opts.judges
      ? stageKey(
          "injected-provider",
          providers.map((j) => j.id),
        )
      : commandIdentity(codexCommand(), harness),
    bun: Bun.version,
    judges: providers.map((p) => p.id),
    tasks: opts.tasks.map((t) => ({
      ...t,
      loaded: {
        case: t.loaded.case,
        sourceHash: t.loaded.case.sessions?.length
          ? directoryDigest(t.loaded.dir)
          : null,
      },
      artifactDigests: [artifactDigest(t.x), artifactDigest(t.y)],
    })),
  };
  const identity = stageKey("diagnostic", effective),
    plannedOrders = opts.tasks.length * providers.length * 2;
  if (opts.plan)
    return {
      status: "planned",
      exitCode: 0,
      identity,
      planned: { writers: 0, orders: plannedOrders },
      phases: [...new Set(opts.tasks.map((t) => t.phase))],
      completedOrders: 0,
      expectedOrders: plannedOrders,
      newWriterCalls: 0,
      newJudgeCalls: 0,
      error: undefined,
      stoppedAfter: undefined,
    };
  mkdirSync(root, { recursive: true });
  const file = join(root, "manifest.json");
  if (existsSync(file)) {
    if (!opts.resume) throw Error("Diagnostic exists; use --resume.");
    if (JSON.parse(readFileSync(file, "utf8")).identity !== identity)
      throw Error(
        "Frozen diagnostic inputs changed; preserve the old experiment.",
      );
  }
  const release = controllerLock(root, identity, opts.recoverLock);
  const controller = new AbortController(),
    restore = setCancellationSignal(controller.signal);
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const inputDir = join(root, "inputs"),
    cache = new StageCache(join(dirname(root), ".prbench-cache/v2"));
  let active = "preparing",
    completedOrders = 0,
    newJudgeCalls = 0;
  const started = performance.now(),
    callDurations: number[] = [];
  const state = () =>
    atomicJson(join(root, "state.json"), {
      experiment: identity,
      active,
      completedOrders,
      expectedOrders: plannedOrders,
      newWriterCalls: 0,
      newJudgeCalls,
      elapsedMs: performance.now() - started,
      forecastRemainingMs: callDurations.length
        ? (callDurations.reduce((a, b) => a + b, 0) / callDurations.length) *
          (plannedOrders - completedOrders)
        : null,
      at: new Date().toISOString(),
    });
  const pairs: { task: string; phase: string; pair: PairResult }[] = [];
  const mismatches: string[] = [],
    unresolved: string[] = [],
    additionalFindings: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let status = "passed",
    error: string | undefined,
    stoppedAfter: string | undefined;
  try {
    if (!existsSync(file)) {
      mkdirSync(inputDir, { recursive: true });
      const frozen = opts.tasks.map((t) => {
        const dir = join(inputDir, "cases", t.id, t.loaded.case.id);
        if (t.loaded.case.sessions?.length)
          cpSync(t.loaded.dir, dir, { recursive: true });
        else {
          mkdirSync(dir, { recursive: true });
          atomicJson(join(dir, "case.json"), t.loaded.case);
        }
        return { ...t, loaded: { ...t.loaded, dir } };
      });
      atomicJson(join(inputDir, "tasks.json"), frozen);
      atomicJson(file, {
        ...effective,
        identity,
        inputHash: directoryDigest(inputDir),
        createdAt: new Date().toISOString(),
        provenance: {
          revision: Bun.spawnSync(["git", "-C", harness, "rev-parse", "HEAD"], {
            stdout: "pipe",
            stderr: "pipe",
          })
            .stdout.toString()
            .trim(),
          harnessHash: directoryDigest(join(harness, "src")),
        },
      });
    }
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const verify = () => {
      if (
        directoryDigest(inputDir) !== manifest.inputHash ||
        implementationDigest(harness, JUDGE_ENTRIES) !== contract ||
        digest(readFileSync(import.meta.path)) !== effective.controllerContract
      )
        throw Error(
          "Frozen diagnostic evidence or judge implementation changed.",
        );
      if (
        !opts.judges &&
        commandIdentity(codexCommand(), harness) !== effective.command
      )
        throw Error("Judge executable changed.");
    };
    verify();
    const tasks: DiagnosticTask[] = JSON.parse(
      readFileSync(join(inputDir, "tasks.json"), "utf8"),
    );
    const realCases = [
      ...new Map(
        tasks
          .filter((t) => t.loaded.case.sessions?.length)
          .map((t) => [t.loaded.case.id, t.loaded]),
      ).values(),
    ];
    if (realCases.length)
      preflight(realCases, {
        cache: join(harness, "node_modules/.cache/prbench-preflight"),
        out: join(root, "preflight.json"),
      });
    state();
    timer = setInterval(() => {
      state();
      console.error(
        `[${opts.kind}] ${completedOrders}/${plannedOrders} orders; ${active}; ${newJudgeCalls} new calls`,
      );
    }, 30000);
    for (const phase of [...new Set(tasks.map((t) => t.phase))]) {
      for (const task of tasks.filter((t) => t.phase === phase))
        for (const provider of providers) {
          if (controller.signal.aborted) throw Error("Diagnostic cancelled.");
          active = `${phase}/${task.id}/${provider.id}`;
          state();
          verify();
          const pairKey = stageKey("diagnostic-pair", {
            experiment: identity,
            task: task.id,
            judge: provider.id,
          });
          const prior = cache.get<PairResult>("diagnostic-pair", pairKey);
          for (const order of ["ab", "ba"] as const) {
            const raw = judgmentPath(
              join(root, "judgments", task.id),
              task.loaded.case.id,
              provider.id,
              task.x.system,
              task.y.system,
              order,
            );
            if (
              prior &&
              existsSync(raw) &&
              digest(readFileSync(raw)) !== prior.orderDigests?.[order]
            )
              throw Error(
                "Accepted diagnostic judgment bytes changed; preserved result rejected.",
              );
          }
          const observed = {
            ...provider,
            ask: async (prompt: string, schema?: object) => {
              verify();
              newJudgeCalls++;
              state();
              const at = performance.now();
              try {
                return await provider.ask(prompt, schema);
              } finally {
                callDurations.push(performance.now() - at);
              }
            },
          };
          const pair = await judgePair({
            loaded: task.loaded,
            facts: task.facts,
            x: task.x,
            y: task.y,
            judge: observed,
            outDir: join(root, "judgments", task.id),
            requiredClaims: Object.fromEntries(
              [task.x, task.y].map((a) => [
                a.system,
                task.expected
                  .filter((e) => e.system === a.system)
                  .map((e) => e.claim),
              ]),
            ),
            controls: {
              cache,
              contract,
              ledgerRoot: root,
              onEvent: (kind) => {
                if (["accepted", "reused"].includes(kind)) {
                  completedOrders++;
                  state();
                }
              },
            },
          });
          verify();
          if (
            prior &&
            (canonical(prior.orderDigests) !== canonical(pair.orderDigests) ||
              canonical(prior.artifactDigests) !==
                canonical(pair.artifactDigests))
          )
            throw Error("Recovered diagnostic judgment identity changed.");
          cache.put("diagnostic-pair", pairKey, pair);
          pairs.push({ task: task.id, phase, pair });
          const findings = diagnosticAssessment(task, pair);
          mismatches.push(...findings.mismatches);
          unresolved.push(...findings.unresolved);
          additionalFindings.push(...findings.additionalFindings);
          atomicJson(join(root, "pairs.json"), pairs);
        }
      if (mismatches.length || unresolved.length) {
        status = mismatches.length ? "failed" : "inconclusive";
        stoppedAfter = phase;
        break;
      }
    }
  } catch (failure) {
    status = "incomplete";
    error = redactEvidence(String(failure));
  } finally {
    if (timer) clearInterval(timer);
    restore();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  try {
    const operations = experimentStatus(root);
    if (
      status === "passed" &&
      (operations.pendingCleanup || completedOrders !== plannedOrders)
    )
      status = "incomplete";
    const summary = {
      schema: "prbench.diagnostic-report/v1",
      kind: opts.kind,
      experiment: identity,
      status,
      exitCode:
        status === "passed"
          ? 0
          : status === "failed"
            ? 1
            : status === "incomplete"
              ? 2
              : 3,
      rubricVersion: RUBRIC_VERSION,
      completedOrders,
      expectedOrders: plannedOrders,
      newWriterCalls: 0,
      newJudgeCalls,
      stoppedAfter,
      error,
      mismatches,
      unresolved: [...new Set(unresolved)],
      additionalFindings: [...new Set(additionalFindings)],
      pendingCleanup: operations.pendingCleanup,
      pairsDigest: stageKey("diagnostic-pairs", pairs),
      preferenceFlips: pairs
        .filter((r) => r.pair.flipped)
        .map((r) => `${r.task}/${r.pair.judge}`),
      limits: [
        "Author-reviewed expectations; not independent human gold labels.",
        "Sol and Terra are same-provider judges.",
        "Preference flips are reported separately from target claim accuracy.",
      ],
    };
    const reportKey = stageKey("diagnostic-report", summary);
    new StageCache(join(root, "derived-reports")).put(
      "report",
      reportKey,
      summary,
    );
    atomicJson(join(root, "summary.json"), summary);
    active = status;
    state();
    atomicJson(join(root, "summary.receipt.json"), {
      experiment: identity,
      reportKey,
      sha256: digest(readFileSync(join(root, "summary.json"))),
    });
    recordEvent(root, {
      stage: "report",
      key: identity,
      kind: "accepted",
      detail: status,
    });
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    release();
  }
}

export function verifiedDiagnosticSummary(root: string) {
  const bytes = readFileSync(join(root, "summary.json")),
    summary = JSON.parse(bytes.toString());
  const receipt = JSON.parse(
    readFileSync(join(root, "summary.receipt.json"), "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(join(root, "manifest.json"), "utf8"),
  );
  const committed = new StageCache(join(root, "derived-reports")).get(
    "report",
    receipt.reportKey,
  );
  if (
    digest(bytes) !== receipt.sha256 ||
    summary.experiment !== receipt.experiment ||
    summary.experiment !== manifest.identity ||
    canonical(summary) !== canonical(committed) ||
    directoryDigest(join(root, "inputs")) !== manifest.inputHash ||
    manifest.contract !== implementationDigest(harness, JUDGE_ENTRIES) ||
    manifest.controllerContract !== digest(readFileSync(import.meta.path))
  )
    throw Error("Diagnostic summary receipt or frozen inputs are invalid.");
  return summary;
}
