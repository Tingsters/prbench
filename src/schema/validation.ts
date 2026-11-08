import { Checker, type Problems } from "./check.ts";

export const VALIDATION_SCHEMA = "prbench.validation/v1";

/** A content observation, not a claim that a test ran atomically on these bytes. */
export interface TreeObservation {
  head: string;
  fingerprint: string;
  at: string;
}

export interface CommandEvidence {
  id: string;
  source: string;
  command: string;
  cwd: string;
  cwdSource?:
    | "recorded-tool-arguments"
    | "recorded-turn-context"
    | "recorded-command-execution";
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  outcome: "completed" | "tool-error" | "interrupted" | "unknown";
  output: string;
  outputSha256?: string;
  truncated: boolean;
  /** Normalized by the collector from an observed command, not from PR prose. */
  check?: {
    kind: "check" | "unknown";
    argv?: string[];
    cwd?: string;
    scriptSha256?: string;
    execution?: "fresh" | "receipt-reuse" | "unknown";
    reason?: string;
  };
  /** Missing observations mean that the tested revision is unknown. */
  before?: TreeObservation;
  after?: TreeObservation;
}

/** Produced by the harness from execution records, never from the PR prose. */
export interface ValidationEvidence {
  schema: typeof VALIDATION_SCHEMA;
  origin: "writer-run" | "historical-recovery";
  coverage: "recorded" | "partial" | "unavailable";
  scope: "observed tool executions; not an attestation of test correctness";
  gaps: string[];
  commands: CommandEvidence[];
  finalTree?: TreeObservation;
}

export function unavailableValidation(reason: string): ValidationEvidence {
  return {
    schema: VALIDATION_SCHEMA,
    origin: "historical-recovery",
    coverage: "unavailable",
    scope: "observed tool executions; not an attestation of test correctness",
    gaps: [reason],
    commands: [],
  };
}

export function checkValidation(value: unknown): Problems {
  const c = new Checker("validation");
  if (!c.object(value, "")) return c.problems;
  const v = value as Record<string, any>;
  if (v.schema !== VALIDATION_SCHEMA)
    c.fail("schema", `expected ${VALIDATION_SCHEMA}`);
  c.oneOf(v.origin, "origin", ["writer-run", "historical-recovery"]);
  c.oneOf(v.coverage, "coverage", ["recorded", "partial", "unavailable"]);
  if (
    v.scope !==
    "observed tool executions; not an attestation of test correctness"
  )
    c.fail("scope", "expected execution evidence scope");
  c.strings(v.gaps, "gaps");
  const tree = (t: unknown, path: string) => {
    if (t === undefined || !c.object(t, path)) return;
    const x = t as Record<string, unknown>;
    c.string(x.head, `${path}.head`);
    c.string(x.fingerprint, `${path}.fingerprint`, {
      pattern: /^[a-f0-9]{64}$/,
    });
    if (
      c.string(x.at, `${path}.at`) &&
      Number.isNaN(Date.parse(x.at as string))
    )
      c.fail(`${path}.at`, "expected timestamp");
  };
  tree(v.finalTree, "finalTree");
  if (c.array(v.commands, "commands")) {
    const ids = new Set<string>();
    v.commands.forEach((x: any, i: number) => {
      const p = `commands[${i}]`;
      if (!c.object(x, p)) return;
      c.string(x.id, `${p}.id`, { pattern: /^V[1-9]\d*$/ });
      if (typeof x.id === "string") {
        if (ids.has(x.id)) c.fail(`${p}.id`, "duplicate id");
        ids.add(x.id);
      }
      for (const k of ["source", "command", "cwd"]) c.string(x[k], `${p}.${k}`);
      if (x.cwdSource !== undefined)
        c.oneOf(x.cwdSource, `${p}.cwdSource`, [
          "recorded-tool-arguments",
          "recorded-turn-context",
          "recorded-command-execution",
        ]);
      for (const k of ["startedAt", "completedAt"]) {
        if (
          x[k] !== undefined &&
          c.string(x[k], `${p}.${k}`) &&
          Number.isNaN(Date.parse(x[k] as string))
        )
          c.fail(`${p}.${k}`, "expected timestamp");
      }
      if (x.exitCode !== undefined && !Number.isInteger(x.exitCode))
        c.fail(`${p}.exitCode`, "expected integer");
      c.oneOf(x.outcome, `${p}.outcome`, [
        "completed",
        "tool-error",
        "interrupted",
        "unknown",
      ]);
      if (typeof x.output !== "string")
        c.fail(`${p}.output`, "expected string");
      c.string(x.outputSha256, `${p}.outputSha256`, {
        optional: true,
        pattern: /^[a-f0-9]{64}$/,
      });
      if (typeof x.truncated !== "boolean")
        c.fail(`${p}.truncated`, "expected boolean");
      if (x.check !== undefined && c.object(x.check, `${p}.check`)) {
        c.oneOf(x.check.kind, `${p}.check.kind`, ["check", "unknown"]);
        if (x.check.kind === "check") {
          c.strings(x.check.argv, `${p}.check.argv`);
          if (!Array.isArray(x.check.argv) || !x.check.argv.length)
            c.fail(`${p}.check.argv`, "expected nonempty argv");
          c.string(x.check.cwd, `${p}.check.cwd`);
          c.oneOf(x.check.execution, `${p}.check.execution`, [
            "fresh",
            "receipt-reuse",
            "unknown",
          ]);
          c.string(x.check.scriptSha256, `${p}.check.scriptSha256`, {
            optional: true,
            pattern: /^[a-f0-9]{64}$/,
          });
        } else c.string(x.check.reason, `${p}.check.reason`);
      }
      tree(x.before, `${p}.before`);
      tree(x.after, `${p}.after`);
    });
    if (v.coverage === "unavailable" && v.commands.length)
      c.fail("coverage", "unavailable evidence cannot contain commands");
    if (v.coverage !== "unavailable" && !v.commands.length)
      c.fail("coverage", "empty execution capture must be unavailable");
    if (v.coverage === "recorded" && v.gaps?.length)
      c.fail("coverage", "recorded evidence cannot have gaps");
    if (
      v.coverage === "recorded" &&
      (!v.finalTree ||
        v.commands.some(
          (x: any) =>
            !x?.before ||
            !x?.after ||
            x?.truncated ||
            ["unknown", "interrupted"].includes(x?.outcome) ||
            x?.cwd?.startsWith?.("unknown"),
        ))
    )
      c.fail(
        "coverage",
        "recorded evidence cannot conceal known execution/content gaps",
      );
  }
  return c.problems;
}
