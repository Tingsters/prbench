/** Keep all writer-affecting orchestration inside its dependency closure. */
import { parseArm, writerEffort } from "./arm.ts";
import { codexSystem } from "../systems/codex.ts";
import { claudeComparisonSystem } from "../systems/claudeComparison.ts";
import type { LoadedCase } from "../schema/case.ts";
import { runCase } from "./runner.ts";
import { prepareCase, type Preparation } from "./comparisonInputs.ts";
export function runComparisonWriter(opts: {
  /** Which CLI writes; defaults to Codex for experiments frozen before providers. */
  agent?: "codex" | "claude";
  loaded: LoadedCase;
  model: string;
  system: string;
  skill?: string;
  runtime?: string;
  timeoutMs: number;
  out: string;
  preparation?: Preparation;
  ledgerRoot?: string;
}) {
  const native = opts.system.endsWith("-native");
  const pinned = native
    ? undefined
    : { id: opts.system, skill: opts.skill!, runtime: opts.runtime! };
  const adapter =
    opts.agent === "claude"
      ? claudeComparisonSystem(
          !native,
          { model: parseArm(opts.model).model, effort: writerEffort(opts.model), timeoutMs: opts.timeoutMs },
          pinned,
        )
      : codexSystem(
          !native,
          {
            model: parseArm(opts.model).model,
            reasoningEffort: writerEffort(opts.model),
            timeoutMs: opts.timeoutMs,
          },
          pinned,
        );
  return runCase(opts.loaded, adapter, {
    outDir: opts.out,
    ledgerRoot: opts.ledgerRoot,
    prepare: (sandbox) =>
      prepareCase(sandbox, opts.loaded.case.id, opts.preparation),
    log: console.error,
  });
}
