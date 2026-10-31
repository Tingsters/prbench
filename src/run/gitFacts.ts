import type { ArtifactCommit } from '../schema/artifact.ts';
import { git } from '../util/exec.ts';

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Commits reachable from `head` but not `base`, oldest first. */
export function commitsBetween(repo: string, base: string, head: string): ArtifactCommit[] {
  const out = git(['log', '--reverse', `--format=%H${FIELD}%B${RECORD}`, `${base}..${head}`], repo);
  return out
    .split(RECORD)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, message = ''] = r.split(FIELD);
      return { sha: sha!.trim(), message: message.trim() };
    });
}

/** Unified diff from base to head, with stable settings so artifacts compare cleanly. */
export function diffBetween(repo: string, base: string, head: string): string {
  return git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames', base, head], repo);
}

export function resolveRef(repo: string, ref: string): string {
  return git(['rev-parse', '--verify', `${ref}^{commit}`], repo);
}
