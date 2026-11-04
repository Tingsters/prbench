import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedCase } from "../schema/case.ts";
import { checkArtifact, type PRArtifact } from "../schema/artifact.ts";
import type { System } from "../systems/types.ts";
import { createSandbox } from "./sandbox.ts";
import { cleanupOwned, ownSandbox } from "./cleanup.ts";
import type { Sandbox } from "./sandbox.ts";
import { retainTraces, traceSnapshot } from "./traces.ts";
import { atomicJson, recordEvent } from "./ledger.ts";

export interface RunOptions {
  /** Write <outDir>/<case>/<system>.json. */
  outDir?: string;
  /** Leave the sandbox on disk for inspection. */
  keepSandbox?: boolean;
  sandboxParent?: string;
  log?: (message: string) => void;
  prepare?: (sandbox: Sandbox) => void;
  /** Injectable disposal for platform fault tests; ownership is always checked first. */
  dispose?: (sandbox: Sandbox) => void;
  ledgerRoot?: string;
}

export interface RunResult {
  artifact: PRArtifact;
  path?: string;
  sandboxRoot?: string;
  cleanup?: "removed" | "kept" | "pending";
}

/** The case as systems see it: without the fact sheet, which is the judges' answer key. */
export function withoutFacts(loaded: LoadedCase): LoadedCase {
  const { facts: _facts, ...rest } = loaded.case;
  return { dir: loaded.dir, case: rest };
}
/** The published reference is also an answer key; only the original-reference system may read it. */
export function withoutAnswers(loaded: LoadedCase): LoadedCase {
  const {
    facts: _facts,
    original: _original,
    provenance: _provenance,
    ...rest
  } = loaded.case;
  return {
    dir: loaded.dir,
    case: { ...rest, provenance: { source: "prbench.writer-input" } },
  };
}

/** Runs one system on one case in a fresh sandbox and checks the artifact it returns. */
export async function runCase(
  loaded: LoadedCase,
  system: System,
  opts: RunOptions = {},
): Promise<RunResult> {
  const support = system.supports(loaded);
  if (!support.supported)
    throw new Error(
      `${system.id} can't run ${loaded.case.id}: ${support.reason}`,
    );
  const log = opts.log ?? (() => {});
  const began = performance.now();
  const sandbox = createSandbox(loaded, { parent: opts.sandboxParent });
  const owner = ownSandbox(sandbox.root);
  const setupMs = performance.now() - began;
  const status: Record<string, any> = {
    case: loaded.case.id,
    system: system.id,
    artifact: "missing",
    stageTimings: { setupMs },
    cleanup: { state: "pending", owner },
  };
  const statusFile = opts.outDir
    ? join(opts.outDir, loaded.case.id, `${system.id}.status.json`)
    : undefined;
  let result: RunResult | undefined;
  let primary: unknown;
  let originalTraces = new Map<string, string>();
  try {
    // A failed ownership write must still reach owned-sandbox cleanup.
    if (statusFile) atomicJson(statusFile, status);
    const preparing = performance.now();
    opts.prepare?.(sandbox);
    originalTraces = traceSnapshot(sandbox);
    status.stageTimings.preparationMs = performance.now() - preparing;
    log(`${loaded.case.id} / ${system.id}: sandbox at ${sandbox.root}`);
    const artifact = await system.run({
      loaded:
        system.id === "original"
          ? withoutFacts(loaded)
          : withoutAnswers(loaded),
      sandbox,
      log,
    });
    artifact.meta.stageTimings = {
      ...artifact.meta.stageTimings,
      ...status.stageTimings,
    };
    const problems = checkArtifact(artifact);
    if (problems.length)
      throw new Error(
        `${system.id} returned an invalid artifact:\n  ${problems.join("\n  ")}`,
      );
    if (artifact.case !== loaded.case.id || artifact.system !== system.id) {
      throw new Error(
        `${system.id} labelled its artifact ${artifact.case}/${artifact.system}`,
      );
    }
    let path: string | undefined;
    if (opts.outDir) {
      const dir = join(opts.outDir, loaded.case.id);
      mkdirSync(dir, { recursive: true });
      path = join(dir, `${system.id}.json`);
      writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n");
    }
    status.artifact = "saved";
    status.writer = artifact.meta.writerOutcome ?? "not-reported";
    result = {
      artifact,
      path,
      sandboxRoot: opts.keepSandbox ? sandbox.root : undefined,
    };
  } catch (error) {
    primary = error;
    status.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (opts.outDir) {
      try {
        status.traces = retainTraces(
          sandbox,
          originalTraces,
          join(opts.outDir, loaded.case.id, `${system.id}.traces`),
        );
      } catch (error) {
        status.traceGap = String(error);
      }
    }
    const cleanupStart = performance.now();
    status.cleanup = { state: "kept", owner };
    if (!opts.keepSandbox) {
      try {
        cleanupOwned(
          owner,
          opts.dispose ? () => opts.dispose!(sandbox) : undefined,
        );
        status.cleanup.state = "removed";
      } catch (error) {
        status.cleanup = {
          state: "pending",
          owner,
          error: error instanceof Error ? error.message : String(error),
        };
        log(
          `Cleanup pending for this invocation; saved artifacts are retained.`,
        );
        if (opts.ledgerRoot)
          recordEvent(opts.ledgerRoot, {
            stage: "cleanup",
            key: owner.token,
            kind: "failed",
            failureKind: "cleanup",
            detail: "Owned sandbox cleanup remains pending.",
          });
      }
    }
    status.stageTimings.cleanupMs = performance.now() - cleanupStart;
    status.stageTimings.totalMs = performance.now() - began;
    if (statusFile) {
      try {
        atomicJson(statusFile, status);
      } catch (error) {
        if (primary === undefined) primary = error;
        else
          log(
            "Status persistence also failed; the original failure is preserved.",
          );
      }
    }
  }
  if (primary) throw primary;
  return { ...result!, cleanup: status.cleanup.state };
}
