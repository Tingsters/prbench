import type { LoadedCase } from '../schema/case.ts';
import type { PRArtifact } from '../schema/artifact.ts';
import type { Sandbox } from '../run/sandbox.ts';

/**
 * What a system gets to work with. The case's fact sheet is deliberately not
 * here: it is the answer key. `loaded.case.facts` is removed, the sandbox
 * doesn't contain it, and adapters must not read other files from the case
 * directory than the ones the case names for systems (bundle, sessions,
 * original PR).
 */
export interface RunContext {
  loaded: LoadedCase;
  sandbox: Sandbox;
  log(message: string): void;
}

/** Why a system can't run a case. */
export type Unsupported = { supported: false; reason: string };

/**
 * A system under test: anything that turns a case into a PR a reviewer would
 * receive. Examples: an agent's native "open a PR" flow, the same flow with a
 * PR-writing tool installed, or the PR that was actually published.
 */
export interface System {
  id: string;
  description: string;
  supports(loaded: LoadedCase): { supported: true } | Unsupported;
  run(ctx: RunContext): Promise<PRArtifact>;
}
