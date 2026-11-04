import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  runDiagnostic,
  type DiagnosticOptions,
  type DiagnosticTask,
} from "./diagnostic.ts";
import { ARTIFACT_SCHEMA, type PRArtifact } from "./schema/artifact.ts";
import {
  CASE_SCHEMA,
  FACTS_SCHEMA,
  loadCase,
  loadFacts,
  type LoadedCase,
} from "./schema/case.ts";

const fullDiff = `-function turnEnd(records) { return Math.max(...records.map(r => r.at)); }
+function turnEnd(records) {
+  const edits = records.filter(r => r.repoEdit);
+  return Math.max(...(edits.length ? edits : records).map(r => r.at));
+}`;
const fragment = `+function turnEnd(records) {
+  const edits = records.filter(r => r.repoEdit);
+  // Remaining calculation and no-edit handling are omitted from this packet.
 [source excerpt ends]`;
const reference =
  "Turn-end timing uses repository edits when available, otherwise timestamps from all turn records.";
const clauses = [
  {
    id: "changed-path-summary",
    claim: "Turn-end timing now uses repository edits.",
    body: "Previously, later command records could extend a turn that contained repository edits. This change selects repository edits for that case. Turn-end timing now uses repository edits.",
    status: "supported",
  },
  {
    id: "universal-exclusion",
    claim: "Outside-repository activity can no longer affect turn-end timing.",
    body: "Outside-repository activity can no longer affect turn-end timing.",
    status: "contradicted",
  },
  {
    id: "qualified-fallback",
    claim: reference,
    body: reference,
    status: "supported",
  },
  {
    id: "missing-fallback-evidence",
    claim: "Turns with no repository edits are discarded.",
    body: "Turns with no repository edits are discarded.",
    status: "unverifiable",
  },
] as const;

export function scopeCalibrationTasks(): DiagnosticTask[] {
  return clauses.map((item) => {
    const missing = item.id === "missing-fallback-evidence";
    const loaded: LoadedCase = {
      dir: "",
      case: {
        schema: CASE_SCHEMA,
        id: `scope-${item.id}`,
        title: "Select repository edits for turn-end timing",
        split: "dev",
        mode: "replay",
        task: "Compare two descriptions of the supplied synthetic change.",
        repo: {
          url: "https://example.invalid/synthetic.git",
          base: "a".repeat(40),
          head: "b".repeat(40),
        },
        sessions: [],
        provenance: { source: "Synthetic scope calibration", synthetic: true },
      },
    };
    const artifact = (system: string, body: string): PRArtifact => ({
      schema: ARTIFACT_SCHEMA,
      case: loaded.case.id,
      system,
      title: loaded.case.title,
      body,
      base: loaded.case.repo.base,
      head: loaded.case.repo.head,
      commits: [],
      diff: missing ? fragment : fullDiff,
      meta: {
        tool: "synthetic-calibration",
        startedAt: "2026-11-03T00:00:00Z",
        durationMs: 0,
      },
    });
    const correct = missing
      ? "Repository edits are selected for the timing path."
      : reference;
    return {
      id: item.id,
      phase: "scope",
      loaded,
      facts: {
        schema: FACTS_SCHEMA,
        claims: missing
          ? ["The visible code selects records marked repoEdit."]
          : [
              "For nonempty turns containing repository edits, the maximum timestamp comes from those edits.",
              "For nonempty turns with no repository edits, timestamps from all records remain the fallback.",
            ],
        context: [
          "Each event has a numeric timestamp and a flag indicating a repository edit.",
        ],
        uncertainties: missing
          ? ["The no-edit branch is not supplied in the packet."]
          : [],
        traps: [],
      },
      x: artifact("calibration-target", item.body),
      y: artifact("calibration-reference", correct),
      expected: [
        {
          system: "calibration-target",
          claim: item.claim,
          statuses: [item.status],
        },
        {
          system: "calibration-reference",
          claim: correct,
          statuses: ["supported"],
        },
      ],
    };
  });
}

export function calibrationTasks(
  historical?: string,
  disputedScreen?: string,
): DiagnosticTask[] {
  const tasks = scopeCalibrationTasks();
  if (!!historical !== !!disputedScreen)
    throw Error(
      "Full calibration requires both historical controls and the disputed screen.",
    );
  if (!historical) return tasks;
  const input = join(resolve(historical), "inputs");
  const readArtifact = (path: string): PRArtifact =>
    JSON.parse(readFileSync(path, "utf8"));
  const targets = {
    pr8: {
      bad: "outside-repository report edits no longer extend an earlier turn past its cutoff",
      good: "when a turn has repository edits, outside-repository report edits no longer extend its cutoff; turns with no repository edits still use timestamps from all turn records",
    },
    pr9: {
      bad: "Start review with provider selection and image-to-prompt mapping in `src/comic/providers.ts`, then the character-sheet and fallback flow in `src/commands/comic.ts` and its end-to-end tests.",
      good: "Start review with `chooseProvider` and the character-sheet/fallback flow in `src/commands/comic.ts`, then image-to-prompt mapping (`pickCodexImages`) in `src/comic/providers.ts` and the end-to-end tests.",
    },
  };
  for (const id of ["pr8", "pr9"] as const) {
    const loaded = loadCase(join(input, id)),
      facts = loadFacts(loaded);
    if (!facts)
      throw Error("Historical calibration requires source-audited facts.");
    const x = readArtifact(join(input, `${id}-known-error.json`)),
      y = readArtifact(join(input, `${id}-corrected.json`));
    tasks.push({
      id: `historical-${id}`,
      phase: "historical-controls",
      accuracySystems: [],
      loaded,
      facts,
      x,
      y,
      expected: [
        {
          system: x.system,
          claim: targets[id].bad,
          statuses: ["contradicted", "unsupported"],
        },
        { system: y.system, claim: targets[id].good, statuses: ["supported"] },
      ],
    });
  }
  const loaded = loadCase(join(input, "pr8")),
    facts = loadFacts(loaded)!;
  const x = readArtifact(join(input, "pr8-corrected.json")),
    y = readArtifact(
      join(
        resolve(disputedScreen!),
        "gpt-6.1-sol/pr8/tracetoon-candidate.json",
      ),
    );
  tasks.push({
    id: "retained-pr8-dispute",
    phase: "retained-dispute",
    accuracySystems: [y.system],
    loaded,
    facts,
    x,
    y,
    expected: [
      { system: x.system, claim: targets.pr8.good, statuses: ["supported"] },
      {
        system: y.system,
        claim: "Turn-end timing now uses repo edits",
        statuses: ["supported"],
      },
    ],
  });
  return tasks;
}
export function calibrateScope(
  opts: DiagnosticOptions & { historical?: string; disputedScreen?: string },
) {
  return runDiagnostic({
    ...opts,
    kind: opts.historical
      ? "scope-calibration/full"
      : "scope-calibration/examples",
    tasks: calibrationTasks(opts.historical, opts.disputedScreen),
  });
}
