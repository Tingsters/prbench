/** Fixed four-draft admission screen. Never a confirmation/performance sample. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { COMPARISON_WRITER_ENTRIES } from "./comparison.ts";
import {
  DIAGNOSTIC_JUDGES,
  JUDGE_ENTRIES,
  runDiagnostic,
  verifiedDiagnosticSummary,
  type DiagnosticTask,
  type DiagnosticOptions,
} from "./diagnostic.ts";
import {
  codexCommand,
  codexRunEnv,
  codexAuthHome,
} from "./agents/codexAuth.ts";
import { commandIdentity, ownerIdentity } from "./run/identity.ts";
import {
  artifactDigest,
  checkArtifact,
  type PRArtifact,
} from "./schema/artifact.ts";
import { loadCase, loadFacts } from "./schema/case.ts";
import { StageCache, implementationDigest, stageKey } from "./run/cache.ts";
import {
  directoryDigest,
  runtimeIdentity,
  type Preparation,
} from "./run/comparisonInputs.ts";
import {
  atomicJson,
  failureKind,
  recordEvent,
  retryDelay,
} from "./run/ledger.ts";
import { controllerLock } from "./run/controller.ts";
import { runComparisonWriter } from "./run/comparisonWriter.ts";
import { preflight, writerCaseIdentity } from "./run/preflight.ts";
import { verifyComparisonIsolation } from "./run/isolation.ts";
import { assertWriterScope } from "./run/scopeAudit.ts";
import { experimentStatus } from "./run/status.ts";
import { PR_PROMPT } from "./systems/agentShared.ts";
import { digest } from "./util/hash.ts";
import { setCancellationSignal } from "./run/cancellation.ts";
import { performanceEvidence, validationCoverage } from "./validationWork.ts";
import { RUBRIC_VERSION } from "./judge/rubric.ts";

export interface AdmissionOptions extends DiagnosticOptions {
  candidateSkill: string;
  cases: string;
  preparation: string;
  calibration: string;
  controls: string;
}
const harness = resolve(import.meta.dir, ".."),
  models = ["gpt-6.1-sol", "gpt-6.1-terra"],
  ids = ["pr8", "pr9"];
const read = <T = any>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8"));
export function assertAdmissionCalibration(root: string) {
  const summary = verifiedDiagnosticSummary(resolve(root));
  const manifest = read(join(resolve(root), "manifest.json"));
  if (
    summary.kind !== "scope-calibration/full" ||
    summary.status !== "passed" ||
    summary.completedOrders !== 28 ||
    summary.expectedOrders !== 28 ||
    summary.newWriterCalls !== 0 ||
    manifest.rubricVersion !== RUBRIC_VERSION ||
    JSON.stringify(manifest.judges) !== JSON.stringify(DIAGNOSTIC_JUDGES) ||
    JSON.stringify(manifest.tasks.map((t: any) => t.id)) !==
      JSON.stringify([
        "changed-path-summary",
        "universal-exclusion",
        "qualified-fallback",
        "missing-fallback-evidence",
        "historical-pr8",
        "historical-pr9",
        "retained-pr8-dispute",
      ])
  )
    throw Error(
      "Admission requires the complete passing 28-order calibration.",
    );
  return summary;
}
export async function admission(opts: AdmissionOptions) {
  if (opts.recoverLock && !opts.resume)
    throw Error("Lock recovery requires --resume.");
  const root = resolve(opts.out),
    skill = resolve(opts.candidateSkill),
    system = "tracetoon-candidate";
  const runtimeName = `tracetoon-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  const runtime = join(skill, "bin", runtimeName),
    identity = runtimeIdentity(skill, runtime, true),
    skillHash = directoryDigest(skill);
  const loaded = ids.map((id) => loadCase(join(resolve(opts.cases), id)));
  if (loaded.some((l) => l.case.split !== "dev" || l.case.excluded))
    throw Error("Admission accepts the two declared development cases only.");
  const preparation: Preparation = read(resolve(opts.preparation));
  for (const id of Object.keys(preparation.cases))
    if (!ids.includes(id)) delete preparation.cases[id];
  for (const item of Object.values(preparation.cases))
    for (const fixture of item.fixtures ?? [])
      fixture.bundle = resolve(
        dirname(resolve(opts.preparation)),
        fixture.bundle,
      );
  const settings = {
    models,
    effort: "medium",
    timeoutMs: 30 * 60_000,
    bun: Bun.version,
    executableSha256: digest(readFileSync(process.execPath)),
    command: commandIdentity(codexCommand(), harness),
    authProfileHash: digest(codexAuthHome()),
    owner: ownerIdentity(),
    prompt: digest(PR_PROMPT),
    environment: stageKey("admission-environment", codexRunEnv(process.env)),
  };
  const writerContract = implementationDigest(
      harness,
      COMPARISON_WRITER_ENTRIES,
    ),
    judgeContract = implementationDigest(harness, JUDGE_ENTRIES);
  const preparationKey = (id: string) =>
    stageKey("admission-preparation", {
      commands: preparation.cases[id]?.commands ?? [],
      fixtures:
        preparation.cases[id]?.fixtures?.map((f) => ({
          name: f.name,
          revision: f.revision,
          sha256: digest(readFileSync(f.bundle)),
        })) ?? [],
    });
  const controls = ids.map((id) =>
    read<PRArtifact>(join(resolve(opts.controls), `${id}-corrected.json`)),
  );
  const stable = {
    schema: "prbench.admission/v1",
    purpose: "diagnostic",
    writerContract,
    judgeContract,
    settings,
    candidate: { identity, hash: skillHash },
    cases: loaded.map((l) => ({
      id: l.case.id,
      hash: directoryDigest(l.dir),
      writerIdentity: writerCaseIdentity(l),
      preparation: preparationKey(l.case.id),
    })),
    controls: controls.map(artifactDigest),
    calibration: existsSync(join(opts.calibration, "manifest.json"))
      ? read(join(opts.calibration, "manifest.json")).identity
      : null,
  };
  const experiment = stageKey("admission", stable);
  if (opts.plan)
    return {
      status: "planned",
      exitCode: 0,
      experiment,
      planned: { writers: 4, orders: 16, isolationProbes: 2 },
      purpose: "diagnostic; cannot pass confirmation adoption",
    };
  assertAdmissionCalibration(opts.calibration);
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  if (
    existsSync(manifestPath) &&
    (!opts.resume || read(manifestPath).experiment !== experiment)
  )
    throw Error(
      "Admission exists or frozen inputs changed; preserve the experiment and use exact-input resume.",
    );
  const release = controllerLock(root, experiment, opts.recoverLock);
  const controller = new AbortController(),
    restore = setCancellationSignal(controller.signal),
    cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let active = "preparing",
    newWriterCalls = 0,
    reusedWriters = 0,
    completedWriters = 0;
  const gaps: string[] = [];
  const state = () =>
    atomicJson(join(root, "state.json"), {
      experiment,
      active,
      newWriterCalls,
      reusedWriters,
      completedWriters,
      expectedWriters: 4,
      at: new Date().toISOString(),
    });
  const cache = new StageCache(join(dirname(root), ".prbench-cache/v2"));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const inputs = join(root, "inputs");
    if (!existsSync(manifestPath)) {
      mkdirSync(inputs, { recursive: true });
      cpSync(skill, join(inputs, "candidate"), { recursive: true });
      for (const l of loaded)
        cpSync(l.dir, join(inputs, "cases", l.case.id), { recursive: true });
      for (const c of controls)
        atomicJson(join(inputs, "controls", `${c.case}.json`), c);
      for (const item of Object.values(preparation.cases))
        for (const fixture of item.fixtures ?? []) {
          const target = join(
            inputs,
            "fixtures",
            `${digest(readFileSync(fixture.bundle))}.bundle`,
          );
          mkdirSync(dirname(target), { recursive: true });
          cpSync(fixture.bundle, target);
          fixture.bundle = target;
        }
      atomicJson(join(inputs, "preparation.json"), preparation);
      cpSync(
        join(harness, "cases/example-greet-default"),
        join(inputs, "probe/example-greet-default"),
        { recursive: true },
      );
      atomicJson(manifestPath, {
        ...stable,
        experiment,
        inputHash: directoryDigest(inputs),
      });
    }
    const manifest = read(manifestPath),
      profile = read<Preparation>(join(inputs, "preparation.json"));
    const verify = () => {
      if (
        directoryDigest(inputs) !== manifest.inputHash ||
        implementationDigest(harness, COMPARISON_WRITER_ENTRIES) !==
          writerContract ||
        commandIdentity(codexCommand(), harness) !== settings.command
      )
        throw Error("Admission writer inputs or implementation changed.");
    };
    verify();
    state();
    timer = setInterval(() => {
      state();
      console.error(`[admission] ${completedWriters}/4 writers; ${active}`);
    }, 30000);
    const frozenSkill = join(inputs, "candidate"),
      frozenRuntime = join(frozenSkill, "bin", runtimeName);
    await verifyComparisonIsolation({
      root,
      experiment,
      probeCase: join(inputs, "probe/example-greet-default"),
      models,
      variants: [
        { system, pinned: { skill: frozenSkill, runtime: frozenRuntime } },
      ],
    });
    const tasks: DiagnosticTask[] = [];
    for (const id of ids)
      for (const model of models) {
        if (controller.signal.aborted) throw Error("Admission cancelled.");
        const l = loadCase(join(inputs, "cases", id));
        preflight([l], {
          cache: join(harness, "node_modules/.cache/prbench-preflight"),
        });
        active = `writer ${id}/${model}`;
        state();
        verify();
        const key = stageKey("admission-writer", {
          settings,
          writerContract,
          candidate: stable.candidate,
          case: writerCaseIdentity(l),
          preparation: stable.cases.find((c) => c.id === id)!.preparation,
          model,
        });
        const file = join(root, model, id, `${system}.json`),
          receipt = file.replace(/\.json$/, ".receipt.json");
        let saved = cache.get<{ artifact: PRArtifact; status: unknown }>(
          "admission-writer",
          key,
        );
        if (!saved) {
          if (existsSync(file))
            throw Error(
              "Saved admission artifact has no immutable generation-cache receipt; preserve it without regenerating.",
            );
          const attemptRoot = join(root, "attempts/writer", key);
          mkdirSync(attemptRoot, { recursive: true });
          const past = readdirSync(attemptRoot).filter((n) =>
            /^\d{3}$/.test(n),
          );
          for (let attempt = past.length + 1; attempt <= 3; attempt++) {
            const dest = join(attemptRoot, String(attempt).padStart(3, "0"));
            mkdirSync(dest);
            newWriterCalls++;
            state();
            recordEvent(root, {
              stage: "writer",
              key,
              kind: "started",
              attempt,
            });
            const start = performance.now();
            try {
              const result = await runComparisonWriter({
                loaded: l,
                model,
                system,
                skill: frozenSkill,
                runtime: frozenRuntime,
                timeoutMs: settings.timeoutMs,
                out: dest,
                preparation: profile,
                ledgerRoot: root,
              });
              verify();
              const artifact = result.artifact;
              if (
                checkArtifact(artifact).length ||
                artifact.case !== id ||
                artifact.system !== system ||
                artifact.meta.model !== model ||
                artifact.meta.writerOutcome?.isError ||
                artifact.meta.writerOutcome?.timedOut
              )
                throw Error(
                  "Admission writer failed; retained output is diagnostic evidence.",
                );
              artifact.meta.runtimeIdentity = identity;
              saved = {
                artifact,
                status: read(join(dest, id, `${system}.status.json`)),
              };
              cache.put("admission-writer", key, saved);
              break;
            } catch (error) {
              const kind = failureKind(error);
              atomicJson(join(dest, "failure.json"), {
                kind,
                error: String(error),
              });
              recordEvent(root, {
                stage: "writer",
                key,
                kind: "failed",
                attempt,
                failureKind: kind,
                durationMs: performance.now() - start,
              });
              if (
                kind !== "transient" ||
                attempt === 3 ||
                controller.signal.aborted
              )
                throw error;
              await Bun.sleep(retryDelay(error, attempt === 1 ? 10000 : 30000));
            }
          }
        } else reusedWriters++;
        if (!saved) throw Error("Persisted writer attempt budget exhausted.");
        const artifact = saved.artifact;
        if (
          checkArtifact(artifact).length ||
          artifact.case !== id ||
          artifact.system !== system ||
          artifact.meta.model !== model
        )
          throw Error("Cached admission writer identity is invalid.");
        assertWriterScope(artifact, file, experiment);
        atomicJson(file, artifact);
        atomicJson(file.replace(/\.json$/, ".status.json"), saved.status);
        atomicJson(receipt, {
          experiment,
          key,
          digest: artifactDigest(artifact),
        });
        recordEvent(root, {
          stage: "writer",
          key,
          kind: "accepted",
          artifact: file,
        });
        if (
          artifact.meta.workflow?.declaredIndependentRoles !== 3 ||
          !artifact.meta.workflow.reviewCurrent ||
          artifact.meta.workflow.reviewVersion !== 2
        )
          gaps.push(
            `${id}/${model}: Three declared roles and a current v2 review are required.`,
          );
        gaps.push(
          ...validationCoverage(performanceEvidence(artifact)).reasons.map(
            (reason) => `${id}/${model}: ${reason}`,
          ),
        );
        const control = read<PRArtifact>(
          join(inputs, "controls", `${id}.json`),
        );
        tasks.push({
          id: `${id}-${model.replaceAll(".", "-")}`,
          phase: "admission",
          accuracySystems: [system],
          loaded: l,
          facts: loadFacts(l)!,
          x: control,
          y: artifact,
          expected: [],
        });
        completedWriters++;
        state();
      }
    verify();
    active = "judging";
    state();
    const judged = await runDiagnostic({
      out: join(root, "judging"),
      resume: opts.resume,
      kind: "admission-accuracy",
      tasks,
    });
    const summary = {
      schema: "prbench.admission-report/v1",
      experiment,
      purpose: "diagnostic",
      status: judged.status,
      exitCode: judged.exitCode,
      completedWriters,
      expectedWriters: 4,
      completedOrders: judged.completedOrders,
      expectedOrders: 16,
      newWriterCalls,
      reusedWriters,
      gaps,
      pendingCleanup: experimentStatus(root).pendingCleanup,
      judging: judged,
    };
    if (gaps.length && summary.status === "passed") {
      summary.status = "inconclusive";
      summary.exitCode = 3;
    }
    if (summary.pendingCleanup) {
      summary.status = "incomplete";
      summary.exitCode = 2;
    }
    atomicJson(join(root, "summary.json"), summary);
    return summary;
  } catch (error) {
    const summary = {
      schema: "prbench.admission-report/v1",
      experiment,
      purpose: "diagnostic",
      status: "incomplete",
      exitCode: 2,
      error: String(error),
      completedWriters,
      expectedWriters: 4,
      newWriterCalls,
      reusedWriters,
    };
    atomicJson(join(root, "summary.json"), summary);
    return summary;
  } finally {
    if (timer) clearInterval(timer);
    restore();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    release();
  }
}
