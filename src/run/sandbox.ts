// A throwaway environment for one system run on one case:
//
//   <root>/repo         the case's repository, checked out on a work branch
//   <root>/remote.git   a bare repo that receives every push
//   <root>/home         HOME / USERPROFILE, holding only the case's sessions
//   <root>/codex        CODEX_HOME
//   <root>/bin          a fake `gh` that records PRs instead of posting them
//
// The checkout has `main` and `origin/main` at the case's base commit, so
// tools see an ordinary feature branch. Nothing the run does can reach the
// user's real home directory, agent logs or GitHub account through these
// paths. (A determined process could still use absolute paths; the sandbox
// isolates discovery, it is not a security boundary.)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import type { Case, CaseSession, LoadedCase } from '../schema/case.ts';
import { git } from '../util/exec.ts';

export interface CapturedPR {
  number: number;
  url: string;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  draft: boolean;
}

export interface GhCall {
  at: string;
  cwd: string;
  args: string[];
  ok: boolean;
  unsupported?: boolean;
  pr?: CapturedPR;
}

export interface Sandbox {
  root: string;
  repo: string;
  remote: string;
  home: string;
  codexHome: string;
  bin: string;
  branch: string;
  /** Where each recorded session was placed, in case order. */
  sessions: string[];
  /** Full environment for processes run inside the sandbox. */
  env: Record<string, string>;
  ghCalls(): GhCall[];
  capturedPRs(): CapturedPR[];
  dispose(): void;
}

export interface SandboxOptions {
  /** Parent directory for the sandbox. Defaults to the OS temp directory. */
  parent?: string;
}

const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');

/** Claude Code stores a project's sessions under its path with every non-alphanumeric character replaced by "-". */
export function claudeProjectDir(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Rewrites a recorded working directory to `to` wherever it appears inside
 * JSON strings, in both its native and forward-slash spelling.
 */
export function rewritePaths(jsonl: string, from: string, to: string): string {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const pairs: [string, string][] = [[from, to]];
  const fwdFrom = from.replace(/\\/g, '/');
  if (fwdFrom !== from) pairs.push([fwdFrom, to.replace(/\\/g, '/')]);
  let out = jsonl;
  for (const [f, t] of pairs) out = out.split(esc(f)).join(esc(t));
  return out;
}

function repoSource(loaded: LoadedCase): string {
  const r = loaded.case.repo;
  return r.bundle ? resolve(loaded.dir, r.bundle) : r.url!;
}

function placeSession(sb: { home: string; codexHome: string; repo: string }, loaded: LoadedCase, s: CaseSession): string {
  const text = rewritePaths(readFileSync(join(loaded.dir, s.file), 'utf8'), s.cwd, sb.repo);
  const dir =
    s.agent === 'claude-code'
      ? join(sb.home, '.claude', 'projects', claudeProjectDir(sb.repo))
      : join(sb.codexHome, 'sessions', 'prbench');
  mkdirSync(dir, { recursive: true });
  const name = basename(s.file);
  const dest = join(dir, s.agent === 'codex' && !name.startsWith('rollout-') ? `rollout-${name}` : name);
  writeFileSync(dest, text);
  return dest;
}

function writeGhShims(bin: string): void {
  mkdirSync(bin, { recursive: true });
  const bun = process.execPath;
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${bun.replace(/\\/g, '/')}" "${FAKE_GH.replace(/\\/g, '/')}" "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(join(bin, 'gh.cmd'), `@"${bun}" "${FAKE_GH}" %*\r\n`);
}

function sandboxEnv(sb: { home: string; codexHome: string; bin: string; root: string }, c: Case): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Windows env names are case-insensitive; drop every spelling of PATH first.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const path = env[pathKey] ?? '';
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'CODEX_HOME']) delete env[k];
  Object.assign(env, {
    [pathKey]: `${sb.bin}${delimiter}${path}`,
    HOME: sb.home,
    USERPROFILE: sb.home,
    CODEX_HOME: sb.codexHome,
    GIT_CONFIG_GLOBAL: join(sb.home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GH_PROMPT_DISABLED: '1',
    PRBENCH_GH_CAPTURE: join(sb.root, 'gh-calls.jsonl'),
    PRBENCH_GH_REPO: `prbench-sandbox/${c.id}`,
    PRBENCH_CASE: c.id,
  });
  return env;
}

export function createSandbox(loaded: LoadedCase, opts: SandboxOptions = {}): Sandbox {
  const c = loaded.case;
  const parent = opts.parent ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `prbench-${c.id}-`));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex');
  const bin = join(root, 'bin');
  const branch = c.repo.branch ?? `prbench/${c.id}`;
  const start = c.mode === 'replay' ? c.repo.head! : c.repo.base;

  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = prbench\n\temail = prbench@example.invalid\n[init]\n\tdefaultBranch = main\n');

    git(['clone', '--quiet', '--no-checkout', repoSource(loaded), repo]);
    git(['config', 'user.name', 'prbench'], repo);
    git(['config', 'user.email', 'prbench@example.invalid'], repo);
    git(['config', 'core.autocrlf', 'false'], repo);
    git(['init', '--quiet', '--bare', remote]);

    // Model "a feature branch off main": main and origin/main sit at base.
    git(['remote', 'set-url', 'origin', `https://github.com/prbench-sandbox/${c.id}.git`], repo);
    git(['remote', 'set-url', '--push', 'origin', remote], repo);
    git(['push', '--quiet', remote, `${c.repo.base}:refs/heads/main`], repo);
    git(['update-ref', 'refs/remotes/origin/main', c.repo.base], repo);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo);
    // Check out the work branch first: git won't move the branch HEAD is on.
    git(['checkout', '--quiet', '-B', branch, start], repo);
    if (branch !== 'main') git(['branch', '--quiet', '--force', 'main', c.repo.base], repo);
    git(['branch', '--quiet', '--set-upstream-to', 'origin/main', 'main'], repo);

    writeGhShims(bin);
    const sb = { root, repo, home, codexHome, bin };
    const sessions = (c.sessions ?? []).map((s) => placeSession(sb, loaded, s));
    const env = sandboxEnv(sb, c);
    const capture = env.PRBENCH_GH_CAPTURE!;

    const ghCalls = (): GhCall[] =>
      existsSync(capture)
        ? readFileSync(capture, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as GhCall)
        : [];

    return {
      root,
      repo,
      remote,
      home,
      codexHome,
      bin,
      branch,
      sessions,
      env,
      ghCalls,
      capturedPRs: () => ghCalls().flatMap((call) => (call.pr ? [call.pr] : [])),
      dispose: () => removeDir(root),
    };
  } catch (err) {
    removeDir(root);
    throw err;
  }
}

function removeDir(dir: string): void {
  // Windows can briefly hold git's files open after the process exits.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
