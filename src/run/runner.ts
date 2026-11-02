import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedCase } from '../schema/case.ts';
import { checkArtifact, type PRArtifact } from '../schema/artifact.ts';
import type { System } from '../systems/types.ts';
import { createSandbox } from './sandbox.ts';
import { cleanupOwned, ownSandbox } from './cleanup.ts';
import type { Sandbox } from './sandbox.ts';

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
}

export interface RunResult {
  artifact: PRArtifact;
  path?: string;
  sandboxRoot?: string;
  cleanup?: 'removed' | 'kept' | 'pending';
}

/** The case as systems see it: without the fact sheet, which is the judges' answer key. */
export function withoutFacts(loaded: LoadedCase): LoadedCase {
  const { facts: _facts, ...rest } = loaded.case;
  return { dir: loaded.dir, case: rest };
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
    artifact: 'missing',
    stageTimings: { setupMs },
  };
  let result: RunResult | undefined;
  let primary: unknown;
  try {
    const preparing = performance.now();
    opts.prepare?.(sandbox);
    status.stageTimings.preparationMs = performance.now() - preparing;
    log(`${loaded.case.id} / ${system.id}: sandbox at ${sandbox.root}`);
    const artifact = await system.run({
      loaded: withoutFacts(loaded),
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
        `${system.id} returned an invalid artifact:\n  ${problems.join('\n  ')}`,
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
      writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n');
    }
    status.artifact = 'saved';
    status.writer = artifact.meta.writerOutcome ?? 'not-reported';
    result = {
      artifact,
      path,
      sandboxRoot: opts.keepSandbox ? sandbox.root : undefined,
    };
  } catch (error) {
    primary = error;
    status.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupStart = performance.now();
    status.cleanup = { state: 'kept', owner };
    if (!opts.keepSandbox) {
      try {
        cleanupOwned(
          owner,
          opts.dispose ? () => opts.dispose!(sandbox) : undefined,
        );
        status.cleanup.state = 'removed';
      } catch (error) {
        status.cleanup = {
          state: 'pending',
          owner,
          error: error instanceof Error ? error.message : String(error),
        };
        log(
          `Cleanup pending for this invocation; saved artifacts are retained.`,
        );
      }
    }
    status.stageTimings.cleanupMs = performance.now() - cleanupStart;
    status.stageTimings.totalMs = performance.now() - began;
    if (opts.outDir) {
      const dir = join(opts.outDir, loaded.case.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${system.id}.status.json`),
        JSON.stringify(status, null, 2) + '\n',
      );
    }
  }
  if (primary) throw primary;
  return { ...result!, cleanup: status.cleanup.state };
}
