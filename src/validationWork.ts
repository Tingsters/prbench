/** Performance eligibility from neutral artifact evidence, never tool files or PR prose. */
import type { PRArtifact } from "./schema/artifact.ts";
import type { ValidationEvidence } from "./schema/validation.ts";
import { digest } from "./util/hash.ts";

export interface ValidationWork {
  validation?: ValidationEvidence;
  codeIdentity?: { base: string; head?: string; diffSha256: string };
}
/** `validation` replaces the artifact's own evidence, e.g. as re-scored from retained traces. */
export function performanceEvidence(
  artifact: PRArtifact,
  validation: ValidationEvidence | undefined = artifact.validation,
): ValidationWork {
  return {
    validation,
    codeIdentity: {
      base: artifact.base,
      head: artifact.head,
      diffSha256: digest(artifact.diff),
    },
  };
}
export function validationCoverage(row: ValidationWork) {
  const evidence = row.validation,
    checks = evidence?.commands.filter((c) => c.check) ?? [];
  const reasons: string[] = [],
    coverage = new Set<string>();
  if (!evidence?.finalTree || !row.codeIdentity?.head)
    reasons.push("Final code identity or content observation is unavailable.");
  else if (evidence.finalTree.head !== row.codeIdentity.head)
    reasons.push("Final content observation belongs to a different revision.");
  if (!checks.length)
    reasons.push("No canonical validation execution is available.");
  const key = (c: (typeof checks)[number]) =>
    JSON.stringify([c.check?.cwd, c.check?.argv]);
  const bound = (c: (typeof checks)[number]) =>
    !!evidence?.finalTree &&
    !!c.before &&
    !!c.after &&
    c.before.head === evidence.finalTree.head &&
    c.after.head === evidence.finalTree.head &&
    c.before.fingerprint === evidence.finalTree.fingerprint &&
    c.after.fingerprint === evidence.finalTree.fingerprint;
  for (const command of checks) {
    const check = command.check!;
    if (
      check.kind !== "check" ||
      check.execution === "unknown" ||
      !check.argv?.length ||
      !check.cwd
    ) {
      reasons.push(
        `${command.id}: ${check.reason ?? "Canonical command or execution mode is unknown."}`,
      );
      continue;
    }
    if (command.outcome !== "completed" || command.exitCode !== 0) {
      reasons.push(`${command.id}: Validation did not complete successfully.`);
      continue;
    }
    if (command.truncated || !bound(command)) {
      reasons.push(
        `${command.id}: Complete execution evidence is not bound to final content.`,
      );
      continue;
    }
    if (
      check.execution === "receipt-reuse" &&
      !checks.some(
        (original) =>
          original !== command &&
          original.check?.execution === "fresh" &&
          key(original) === key(command) &&
          original.outcome === "completed" &&
          original.exitCode === 0 &&
          !original.truncated &&
          bound(original) &&
          !!original.completedAt &&
          !!command.startedAt &&
          Date.parse(original.completedAt) <= Date.parse(command.startedAt),
      )
    ) {
      reasons.push(
        `${command.id}: Reuse has no earlier captured pass on the same final content.`,
      );
      continue;
    }
    coverage.add(key(command));
  }
  return {
    coverage: [...coverage].sort(),
    commandIds: checks.map((c) => c.id),
    reasons,
  };
}
export function compareValidationWork(
  baseline: ValidationWork | undefined,
  candidate: ValidationWork,
) {
  const b = validationCoverage(baseline ?? {}),
    c = validationCoverage(candidate);
  const reasons = [
    ...b.reasons.map((r) => `baseline: ${r}`),
    ...c.reasons.map((r) => `candidate: ${r}`),
  ];
  if (reasons.length)
    return { status: "unknown" as const, reasons, baseline: b, candidate: c };
  if (
    baseline?.codeIdentity?.base !== candidate.codeIdentity?.base ||
    baseline?.codeIdentity?.head !== candidate.codeIdentity?.head ||
    baseline?.codeIdentity?.diffSha256 !== candidate.codeIdentity?.diffSha256
  )
    reasons.push("Paired descriptions do not refer to identical case code.");
  if (JSON.stringify(b.coverage) !== JSON.stringify(c.coverage))
    reasons.push(
      "Completed validation targets or flags differ between paired writers.",
    );
  return {
    status: reasons.length ? ("unmatched" as const) : ("matched" as const),
    reasons,
    baseline: b,
    candidate: c,
  };
}
