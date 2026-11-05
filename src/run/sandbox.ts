// A throwaway environment for one system run on one case:
//
//   <root>/work/<name>  the case's repository, checked out on a work branch
//                       (<name> is the recorded repository's directory name)
//   <root>/git          its git directory (the checkout's .git is a pointer)
//   <root>/remote.git   a bare repo that receives every push
//   <root>/home         HOME / USERPROFILE, holding only the case's sessions
//   <root>/codex        CODEX_HOME
//   <root>/appdata      APPDATA, LOCALAPPDATA and XDG_* directories
//   <root>/bin          a fake `gh` that records PRs instead of posting them
//
// The checkout has `main` and `origin/main` at the case's base commit, so
// tools see an ordinary feature branch. Git may only use local repositories
// (GIT_ALLOW_PROTOCOL=file), so a fetch can't reach the network. Nothing the
// run does can reach the user's real home directory, agent logs or GitHub
// account through these paths. (A determined process could still use
// absolute paths; the sandbox isolates discovery, it is not a security
// boundary.)
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, posix, resolve, win32 } from 'node:path';
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
  /**
   * The checkout's git directory, kept outside the checkout (<root>/git, with
   * a .git pointer file in the checkout). Claude Code treats paths under
   * `.git/` as sensitive and won't let an unattended agent write there, but
   * tools like Tracetoon keep their working files in the git directory.
   */
  gitDir: string;
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

/** "C:\x\y" -> "/c/x/y", the spelling Git Bash (MSYS) uses; undefined for non-drive paths. */
export function msysPath(path: string): string | undefined {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : undefined;
}

/** File URLs use the recorded path's syntax even when replay runs on another OS. */
function fileUri(path: string): string | undefined {
  const fwd = path.replace(/\\/g, '/');
  if (!/^(?:[A-Za-z]:\/|\/)/.test(fwd)) return undefined;
  const prefix = fwd.startsWith('//') ? 'file:' : fwd.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(fwd).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * Rewrites recorded paths wherever they appear inside JSON strings, in each
 * spelling a Windows path takes in agent logs: native (C:\x), forward-slash
 * (C:/x) and Git Bash (/c/x). Longer paths win, and each occurrence is
 * rewritten once, so a repository path and its parent can both be mapped.
 */
export function rewritePaths(jsonl: string, pairs: [from: string, to: string][]): string {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const map = new Map<string, string>();
  // A Windows path replayed on a POSIX host keeps its tail's backslashes
  // (C:\repo\src\a.ts -> /sandbox/repo\src\a.ts), which no POSIX tool reads
  // as a path inside the checkout; those tails get POSIX separators too.
  const posixTail = new Set<string>();
  for (const [from, to] of pairs) {
    const fromUri = fileUri(from), toUri = fileUri(to);
    if (fromUri && toUri) map.set(esc(fromUri), esc(toUri));
    map.set(esc(from), esc(to));
    if (/^(?:[A-Za-z]:)?\\/.test(from) && to.startsWith('/')) posixTail.add(esc(from));
    const fwd = from.replace(/\\/g, '/');
    if (fwd !== from) map.set(esc(fwd), esc(to.replace(/\\/g, '/')));
    const msys = msysPath(from);
    if (msys) map.set(esc(msys), esc(msysPath(to) ?? to.replace(/\\/g, '/')));
  }
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  if (keys.length === 0) return jsonl;
  // Whole paths only: not preceded by a path character, and followed by a
  // separator, a quote or the end, so "/work" doesn't match ".github/workflows".
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // The tail is JSON-escaped backslash + name segments, stopping at quotes,
  // whitespace and further escapes, so a command's other arguments are kept.
  const re = new RegExp(`(?<![\\w.\\-~/\\\\])(${alt})((?:\\\\\\\\[^"\\\\\\s]+)*)(?=[\\\\/"'\`\\s]|$)`, 'g');
  return jsonl.replace(re, (_m, key: string, tail: string) =>
    map.get(key)! + (posixTail.has(key) ? tail.replaceAll('\\\\', '/') : tail));
}

/** Where a case's repository was recorded, falling back to the first session's cwd. */
export function recordedPath(c: Case): string | undefined {
  return c.repo.recordedPath ?? c.sessions?.[0]?.cwd;
}

/** Path pairs that map the recorded repository and its parent onto the sandbox checkout and its parent. */
export function pathPairs(c: Case, repo: string): [string, string][] {
  const rec = recordedPath(c);
  if (!rec) return [];
  const pairs: [string, string][] = [[rec, repo]];
  const parent = rec.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
  const repoParent = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(repo) ? win32.dirname(repo) : posix.dirname(repo);
  if (parent && parent !== rec && !/^[A-Za-z]:$|^$/.test(parent)) pairs.push([parent, repoParent]);
  return pairs;
}

function repoSource(loaded: LoadedCase): string {
  const r = loaded.case.repo;
  return r.bundle ? resolve(loaded.dir, r.bundle) : r.url!;
}

function firstTimestamp(jsonl: string): Date {
  for (const line of jsonl.split('\n', 50)) {
    const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
    if (m && !Number.isNaN(Date.parse(m[1]!))) return new Date(m[1]!);
  }
  return new Date();
}

function placeSession(
  sb: { home: string; codexHome: string },
  loaded: LoadedCase,
  s: CaseSession,
  pairs: [string, string][],
): string {
  const text = rewritePaths(readFileSync(join(loaded.dir, s.file), 'utf8'), pairs);
  const cwd = rewritePaths(JSON.stringify(s.cwd), pairs);
  let dir: string;
  let name = basename(s.file);
  if (s.agent === 'claude-code') {
    dir = join(sb.home, '.claude', 'projects', claudeProjectDir(JSON.parse(cwd)));
  } else {
    // Codex keeps rollouts under sessions/YYYY/MM/DD/rollout-*.jsonl.
    const d = firstTimestamp(text);
    const p = (n: number) => String(n).padStart(2, '0');
    dir = join(sb.codexHome, 'sessions', String(d.getUTCFullYear()), p(d.getUTCMonth() + 1), p(d.getUTCDate()));
    if (!name.startsWith('rollout-')) name = `rollout-${name}`;
  }
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
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
  if (process.platform === 'win32') {
    // Bun.which() resolves native executables before .cmd wrappers. A real
    // gh.exe here also covers tools that resolve gh before invoking it.
    const hash = createHash('sha256').update(readFileSync(FAKE_GH)).digest('hex').slice(0, 16);
    const cache = resolve(import.meta.dir, '../../node_modules/.cache/prbench-gh', `${Bun.version}-${process.arch}-${hash}`);
    mkdirSync(cache, { recursive: true });
    const executable = join(cache, 'gh.exe');
    if (!existsSync(executable)) {
      const temporary = join(cache, `gh-${process.pid}.exe`);
      const build = Bun.spawnSync([bun, 'build', '--compile', '--outfile', temporary, FAKE_GH], { stdout: 'pipe', stderr: 'pipe' });
      if (build.exitCode !== 0) throw new Error(`Could not build the Windows fake gh: ${build.stderr.toString().slice(-500)}`);
      try { renameSync(temporary, executable); }
      catch (err) { if (!existsSync(executable)) throw err; }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    copyFileSync(executable, join(bin, 'gh.exe'));
  }
}

const DROPPED_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'TRACETOON_CONFIG',
  'TRACETOON_BIN',
  'TRACETOON_ASSETS',
  'TRACETOON_LAUNCHER',
  'TRACETOON_ALLOW_DOWNLOAD',
  // Claude Code reads these from the parent (a host session, its login or its
  // settings); runs add back only the chosen credentials.
  'CLAUDECODE',
  'PRBENCH_CLAUDE_OAUTH_TOKEN',
];
const DROPPED_PREFIXES = ['CODEX_', 'ANTHROPIC_', 'CLAUDE_CODE_'];

function sandboxEnv(sb: { home: string; codexHome: string; bin: string; root: string }, c: Case): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Windows env names are case-insensitive; drop every spelling of PATH first.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const path = env[pathKey] ?? '';
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' || DROPPED_PREFIXES.some((p) => k.toUpperCase().startsWith(p)) || DROPPED_ENV.includes(k.toUpperCase())) delete env[k];
  const appdata = join(sb.root, 'appdata');
  for (const d of ['roaming', 'local', 'config', 'data', 'state', 'cache']) mkdirSync(join(appdata, d), { recursive: true });
  Object.assign(env, {
    [pathKey]: `${sb.bin}${delimiter}${path}`,
    HOME: sb.home,
    USERPROFILE: sb.home,
    CODEX_HOME: sb.codexHome,
    APPDATA: join(appdata, 'roaming'),
    LOCALAPPDATA: join(appdata, 'local'),
    XDG_CONFIG_HOME: join(appdata, 'config'),
    XDG_DATA_HOME: join(appdata, 'data'),
    XDG_STATE_HOME: join(appdata, 'state'),
    XDG_CACHE_HOME: join(appdata, 'cache'),
    GIT_CONFIG_GLOBAL: join(sb.home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
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
  // The long form of the path: Windows temp dirs often come back in 8.3 form
  // (C:\Users\ABCDEF~1), which agents and the rewritten logs would spell differently.
  const root = realpathSync.native(mkdtempSync(join(parent, `prbench-${c.id}-`)));
  const rec = recordedPath(c);
  // The recorded path's own syntax decides its last segment: a Windows path
  // (C:\replay\tracetoon) replayed on Linux has no "/", and the host's
  // basename would keep the backslashes as one directory name.
  const repo = join(root, 'work', rec ? rec.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo' : 'repo');
  const remote = join(root, 'remote.git');
  const gitDir = join(root, 'git');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex');
  const bin = join(root, 'bin');
  const branch = c.repo.branch ?? `prbench/${c.id}`;
  const start = c.mode === 'replay' ? c.repo.head! : c.repo.base;

  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(dirname(repo), { recursive: true });
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = prbench\n\temail = prbench@example.invalid\n[init]\n\tdefaultBranch = main\n');

    // Fetch every ref, not just branches and tags as a clone would: a case's
    // bundle may keep its commits under any ref.
    git(['init', '--quiet', '--initial-branch', 'prbench-empty', '--separate-git-dir', gitDir, repo]);
    git(['config', 'user.name', 'prbench'], repo);
    git(['config', 'user.email', 'prbench@example.invalid'], repo);
    git(['config', 'core.autocrlf', 'false'], repo);
    git(['fetch', '--quiet', '--no-tags', repoSource(loaded), '+refs/*:refs/prbench-source/*'], repo);
    git(['init', '--quiet', '--bare', remote]);

    // Model "a feature branch off main": main and origin/main sit at base.
    git(['remote', 'add', 'origin', `https://github.com/prbench-sandbox/${c.id}.git`], repo);
    git(['remote', 'set-url', '--push', 'origin', remote], repo);
    git(['push', '--quiet', remote, `${c.repo.base}:refs/heads/main`], repo);
    git(['update-ref', 'refs/remotes/origin/main', c.repo.base], repo);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo);
    // Check out the work branch first: git won't move the branch HEAD is on.
    git(['checkout', '--quiet', '-B', branch, start], repo);
    if (branch !== 'main') git(['branch', '--quiet', '--force', 'main', c.repo.base], repo);
    git(['branch', '--quiet', '--set-upstream-to', 'origin/main', 'main'], repo);
    for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/prbench-source/'], repo).split('\n').filter(Boolean)) {
      git(['update-ref', '-d', ref], repo);
    }

    writeGhShims(bin);
    const sb = { root, repo, home, codexHome, bin };
    const pairs = pathPairs(c, repo);
    const sessions = (c.sessions ?? []).map((s) => placeSession(sb, loaded, s, pairs));
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
      gitDir,
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
    try { removeDir(root); } catch { /* Preserve the creation error rather than masking it with cleanup. */ }
    throw err;
  }
}

function removeDir(dir: string): void {
  // Windows can briefly hold git's files open after the process exits.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
