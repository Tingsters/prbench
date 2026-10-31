// A case is a fixed starting point that every system under test receives
// unchanged: a repository snapshot, the task the agent was given and, for
// replay cases, the recorded agent sessions and the code change they made.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Checker, type Problems } from './check.ts';

export const CASE_SCHEMA = 'prbench.case/v1';
export const FACTS_SCHEMA = 'prbench.facts/v1';

export const MODES = ['replay', 'e2e'] as const;
export const SPLITS = ['dev', 'test'] as const;
// Agents whose session logs a sandbox knows where to place. Add more as adapters need them.
export const AGENTS = ['claude-code', 'codex'] as const;

export type Mode = (typeof MODES)[number];
export type Split = (typeof SPLITS)[number];
export type Agent = (typeof AGENTS)[number];

export interface CaseRepo {
  /** A git bundle inside the case directory (preferred: the case is self-contained). */
  bundle?: string;
  /** Or a clone URL / local path. Exactly one of bundle and url is set. */
  url?: string;
  /** Commit the change starts from. */
  base: string;
  /** Commit holding the finished change. Required for replay cases. */
  head?: string;
  /** Branch name the work is checked out on in the sandbox. Defaults to "prbench/<case id>". */
  branch?: string;
  /**
   * Where the repository was checked out when the sessions were recorded, as
   * the logs spell it. Sandboxes rewrite it, and its parent directory, to the
   * sandbox checkout and its parent. Defaults to the first session's cwd.
   */
  recordedPath?: string;
}

export interface CaseSession {
  agent: Agent;
  /** JSONL transcript, relative to the case directory. */
  file: string;
  /**
   * The working directory the session was recorded in: the repository or its
   * parent directory. Sandboxes rewrite it (see CaseRepo.recordedPath) so
   * tools that match sessions to repositories by path still find them.
   */
  cwd: string;
}

export interface CaseOriginal {
  /** Title of the PR a person (or the original agent) published, if any. */
  title: string;
  /** Its body, as a Markdown file relative to the case directory. */
  body: string;
  url?: string;
}

export interface Case {
  schema: typeof CASE_SCHEMA;
  id: string;
  title: string;
  split: Split;
  mode: Mode;
  repo: CaseRepo;
  /** The request the agent was working on, as the user phrased it. */
  task: string;
  /** Replay only: the recorded sessions that produced the change. */
  sessions?: CaseSession[];
  /** Fact sheet, relative to the case directory. */
  facts?: string;
  original?: CaseOriginal;
  /** Where the case came from and whether it is synthetic. */
  provenance: { source: string; synthetic?: boolean; license?: string; notes?: string };
}

/**
 * Hand-checked facts about the change, written from the code and sessions
 * only, never from any PR description. Judges score descriptions against it.
 */
export interface Facts {
  schema: typeof FACTS_SCHEMA;
  /** Things a good description should convey, each one checkable against the diff or sessions. */
  claims: string[];
  /** Background a reviewer would want: why, prior behaviour, constraints. */
  context: string[];
  /** What the evidence does not establish (e.g. tests not run). Good descriptions don't overclaim these. */
  uncertainties: string[];
  /** Plausible but wrong statements a writer might make. */
  traps: string[];
}

export interface LoadedCase {
  dir: string;
  case: Case;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[0-9a-f]{7,40}$/;

/** Checks a parsed case.json. With `dir`, also checks that referenced files exist. */
export function checkCase(value: unknown, dir?: string): Problems {
  const c = new Checker();
  if (!c.object(value, '')) return c.problems;
  const v = value as Record<string, unknown>;
  if (v.schema !== CASE_SCHEMA) c.fail('schema', `expected "${CASE_SCHEMA}"`);
  c.string(v.id, 'id', { pattern: ID });
  c.string(v.title, 'title');
  c.oneOf(v.split, 'split', SPLITS);
  const mode = c.oneOf(v.mode, 'mode', MODES) ? (v.mode as Mode) : undefined;
  c.string(v.task, 'task');

  const file = (rel: unknown, path: string) => {
    if (!c.string(rel, path)) return;
    if (dir && !existsSync(join(dir, rel as string))) c.fail(path, `file not found: ${rel}`);
  };

  if (c.object(v.repo, 'repo')) {
    const r = v.repo as Record<string, unknown>;
    if ((r.bundle === undefined) === (r.url === undefined)) c.fail('repo', 'set exactly one of bundle and url');
    if (r.bundle !== undefined) file(r.bundle, 'repo.bundle');
    c.string(r.url, 'repo.url', { optional: true });
    c.string(r.base, 'repo.base', { pattern: SHA });
    c.string(r.head, 'repo.head', { optional: mode !== 'replay', pattern: SHA });
    c.string(r.recordedPath, 'repo.recordedPath', { optional: true });
    if (c.string(r.branch, 'repo.branch', { optional: true }) && r.branch === 'main') {
      c.fail('repo.branch', 'must not be "main": the sandbox keeps main at the base commit');
    }
  }

  if (mode === 'replay' && (!Array.isArray(v.sessions) || v.sessions.length === 0)) {
    c.fail('sessions', 'replay cases need at least one recorded session');
  }
  if (c.array(v.sessions, 'sessions', true) && v.sessions) {
    (v.sessions as unknown[]).forEach((s, i) => {
      const p = `sessions[${i}]`;
      if (!c.object(s, p)) return;
      const ss = s as Record<string, unknown>;
      c.oneOf(ss.agent, `${p}.agent`, AGENTS);
      file(ss.file, `${p}.file`);
      c.string(ss.cwd, `${p}.cwd`);
    });
  }

  if (v.facts !== undefined) {
    file(v.facts, 'facts');
    if (dir && typeof v.facts === 'string' && existsSync(join(dir, v.facts))) {
      for (const p of checkFacts(readJson(join(dir, v.facts)))) c.fail('facts', p);
    }
  }

  if (v.original !== undefined && c.object(v.original, 'original')) {
    const o = v.original as Record<string, unknown>;
    c.string(o.title, 'original.title');
    file(o.body, 'original.body');
    c.string(o.url, 'original.url', { optional: true });
  }

  if (c.object(v.provenance, 'provenance')) {
    const p = v.provenance as Record<string, unknown>;
    c.string(p.source, 'provenance.source');
  }
  return c.problems;
}

export function checkFacts(value: unknown): Problems {
  const c = new Checker();
  if (!c.object(value, '')) return c.problems;
  const v = value as Record<string, unknown>;
  if (v.schema !== FACTS_SCHEMA) c.fail('schema', `expected "${FACTS_SCHEMA}"`);
  c.strings(v.claims, 'claims');
  if (Array.isArray(v.claims) && v.claims.length === 0) c.fail('claims', 'expected at least one claim');
  c.strings(v.context, 'context');
  c.strings(v.uncertainties, 'uncertainties');
  c.strings(v.traps, 'traps');
  return c.problems;
}

export class CaseError extends Error {
  constructor(
    readonly where: string,
    readonly problems: Problems,
  ) {
    super(`${where}:\n  ${problems.join('\n  ')}`);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { __unreadable: String(err) };
  }
}

/** Loads and checks one case directory. Throws CaseError listing every problem. */
export function loadCase(dir: string): LoadedCase {
  const path = join(dir, 'case.json');
  if (!existsSync(path)) throw new CaseError(dir, ['case.json not found']);
  const value = readJson(path);
  const problems = checkCase(value, dir);
  const id = (value as { id?: unknown }).id;
  const name = dir.split(/[\\/]/).pop();
  if (problems.length === 0 && id !== name) problems.push(`id: "${String(id)}" must match the directory name "${name}"`);
  if (problems.length) throw new CaseError(path, problems);
  return { dir, case: value as Case };
}

export function loadFacts(loaded: LoadedCase): Facts | undefined {
  return loaded.case.facts ? (readJson(join(loaded.dir, loaded.case.facts)) as Facts) : undefined;
}

/** Every case directory (one holding case.json) directly under `root`. */
export function caseDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'case.json')))
    .map((d) => join(root, d.name))
    .sort();
}
