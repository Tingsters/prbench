/**
 * A writer arm: a model id, optionally with a reasoning effort
 * (`gpt-6-luna@low`). The full spec is the arm's identity in manifests and
 * result paths; agents receive the bare model and the effort separately.
 */
import { CLAUDE_EFFORTS } from "../agents/claude.ts";
import { REASONING_EFFORTS } from "../agents/codex.ts";

/** Effort used when a spec names none, matching earlier experiments. */
export const DEFAULT_WRITER_EFFORT = "medium";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseArm(spec: string): { model: string; effort?: string } {
  const [model, effort, ...extra] = spec.split("@");
  if (extra.length || !model || !MODEL_ID.test(model) || effort === "")
    throw new Error(`invalid writer model "${spec}"; use model or model@effort`);
  return effort === undefined ? { model } : { model, effort };
}

/** Throws unless every spec parses, is distinct, and names an effort the provider's agent accepts. */
export function checkArms(specs: string[], agent: "claude" | "codex"): void {
  if (new Set(specs).size !== specs.length) throw new Error("--models must be distinct.");
  const allowed: readonly string[] = agent === "claude" ? CLAUDE_EFFORTS : REASONING_EFFORTS;
  for (const spec of specs) {
    const { effort } = parseArm(spec);
    if (effort !== undefined && !allowed.includes(effort))
      throw new Error(`Unknown ${agent} effort "${effort}" in "${spec}"; use one of ${allowed.join(", ")}.`);
  }
}

export const writerEffort = (spec: string) => parseArm(spec).effort ?? DEFAULT_WRITER_EFFORT;

/** Whether an artifact's metadata was produced by this arm. */
export function artifactMatchesArm(
  meta: { model?: string; reasoningEffort?: string },
  spec: string,
): boolean {
  const { model, effort } = parseArm(spec);
  return meta.model === model && (effort === undefined || meta.reasoningEffort === effort);
}
