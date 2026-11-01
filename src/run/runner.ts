import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedCase } from '../schema/case.ts';
import { checkArtifact, type PRArtifact } from '../schema/artifact.ts';
import type { System } from '../systems/types.ts';
import { createSandbox } from './sandbox.ts';

export interface RunOptions {
  /** Write <outDir>/<case>/<system>.json. */
  outDir?: string;
  /** Leave the sandbox on disk for inspection. */
  keepSandbox?: boolean;
  sandboxParent?: string;
  log?: (message: string) => void;
}

export interface RunResult {
  artifact: PRArtifact;
  path?: string;
  sandboxRoot?: string;
}

/** The case as systems see it: without the fact sheet, which is the judges' answer key. */
export function withoutFacts(loaded: LoadedCase): LoadedCase {
  const { facts: _facts, ...rest } = loaded.case;
  return { dir: loaded.dir, case: rest };
}

/** Runs one system on one case in a fresh sandbox and checks the artifact it returns. */
export async function runCase(loaded: LoadedCase, system: System, opts: RunOptions = {}): Promise<RunResult> {
  const support = system.supports(loaded);
  if (!support.supported) throw new Error(`${system.id} can't run ${loaded.case.id}: ${support.reason}`);
  const log = opts.log ?? (() => {});
  const sandbox = createSandbox(loaded, { parent: opts.sandboxParent });
  try {
    log(`${loaded.case.id} / ${system.id}: sandbox at ${sandbox.root}`);
    const artifact = await system.run({ loaded: withoutFacts(loaded), sandbox, log });
    const problems = checkArtifact(artifact);
    if (problems.length) throw new Error(`${system.id} returned an invalid artifact:\n  ${problems.join('\n  ')}`);
    if (artifact.case !== loaded.case.id || artifact.system !== system.id) {
      throw new Error(`${system.id} labelled its artifact ${artifact.case}/${artifact.system}`);
    }
    let path: string | undefined;
    if (opts.outDir) {
      const dir = join(opts.outDir, loaded.case.id);
      mkdirSync(dir, { recursive: true });
      path = join(dir, `${system.id}.json`);
      writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n');
    }
    return { artifact, path, sandboxRoot: opts.keepSandbox ? sandbox.root : undefined };
  } finally {
    if (!opts.keepSandbox) sandbox.dispose();
  }
}
