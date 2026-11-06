import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCase } from '../src/schema/case.ts';
import { claudeProjectDir, createSandbox, msysPath, pathPairs, rewritePaths } from '../src/run/sandbox.ts';
import { exec, git } from '../src/util/exec.ts';
import { cleanupTemps, copyExample, EXAMPLE, tempDir } from './helpers.ts';

afterAll(cleanupTemps);

/** Runs `gh` the way an agent's shell would find it: through PATH. */
function gh(args: string[], env: Record<string, string>, cwd: string) {
  const cmd = process.platform === 'win32' ? ['cmd', '/d', '/c', 'gh', ...args] : ['gh', ...args];
  return exec(cmd, { env, cwd });
}

describe('rewritePaths', () => {
  test('rewrites local preview URLs without mapping a neighboring repository', () => {
    const text = JSON.stringify({ request: 'Open file:///C:/dev/tool/.git/tracetoon/runs/one/out/preview.html', other: 'file:///C:/dev/toolkit/file.html' });
    expect(JSON.parse(rewritePaths(text, [['C:\\dev\\tool', 'D:\\temp\\work\\tool']]))).toEqual({
      request: 'Open file:///D:/temp/work/tool/.git/tracetoon/runs/one/out/preview.html', other: 'file:///C:/dev/toolkit/file.html',
    });
  });

  test('maps encoded file URLs across platform path styles exactly once', () => {
    const text = JSON.stringify({ preview: 'file:///C:/My%20Repo/tool/preview.html' });
    expect(JSON.parse(rewritePaths(text, [['C:\\My Repo\\tool', '/sandbox/work/tool'], ['C:\\My Repo', '/sandbox/work']]))).toEqual({ preview: 'file:///sandbox/work/tool/preview.html' });
    expect(JSON.parse(rewritePaths(JSON.stringify({ preview: 'file:///old/repo/preview.html' }), [['/old/repo', 'D:\\new repo#one']]))).toEqual({ preview: 'file:///D:/new%20repo%23one/preview.html' });
  });

  test('rewrites a Windows path in both spellings inside JSON strings', () => {
    const from = 'C:\\Users\\ada\\repo';
    const to = 'D:\\tmp\\sb\\repo';
    const line = JSON.stringify({ cwd: from, file: `${from}\\a.ts`, alt: 'C:/Users/ada/repo/b.ts' });
    expect(JSON.parse(rewritePaths(line, [[from, to]]))).toEqual({
      cwd: to,
      file: `${to}\\a.ts`,
      alt: 'D:/tmp/sb/repo/b.ts',
    });
  });

  test('gives a Windows path replayed on a POSIX host POSIX separators throughout', () => {
    const from = 'C:\\prbench-replay\\tracetoon';
    const line = JSON.stringify({
      cwd: from,
      file: `${from}\\src\\digest\\build.ts`,
      plan: 'C:\\prbench-replay\\home\\.claude\\plans\\kite.md',
      cmd: `cd ${from}\\src && type C:\\other\\x.txt`,
    });
    expect(JSON.parse(rewritePaths(line, [[from, '/sb/work/tracetoon'], ['C:\\prbench-replay', '/sb/work']]))).toEqual({
      cwd: '/sb/work/tracetoon',
      file: '/sb/work/tracetoon/src/digest/build.ts',
      plan: '/sb/work/home/.claude/plans/kite.md',
      // Only the mapped path changes; unrelated host paths keep their spelling.
      cmd: 'cd /sb/work/tracetoon/src && type C:\\other\\x.txt',
    });
  });

  test('rewrites the Git Bash spelling of a Windows path too', () => {
    const line = JSON.stringify({ cwd: '/c/Users/ada/repo', cmd: 'cd /c/Users/ada/repo/src && ls', other: '/c/Users/ada/repository' });
    expect(JSON.parse(rewritePaths(line, [['C:\\Users\\ada\\repo', 'D:\\tmp\\sb\\repo']]))).toEqual({
      cwd: '/d/tmp/sb/repo',
      cmd: 'cd /d/tmp/sb/repo/src && ls',
      other: '/c/Users/ada/repository',
    });
    expect(msysPath('C:\\Users\\ada')).toBe('/c/Users/ada');
    expect(msysPath('/home/ada')).toBeUndefined();
  });

  test('rewrites whole paths only', () => {
    const line = JSON.stringify({
      cwd: '/work/greet',
      cmd: 'cd /work/greet && ls',
      longer: '/work/greeter-two',
      inside: '.github/workflows/ci.yml',
      nested: '/home/x/work/greet',
    });
    expect(JSON.parse(rewritePaths(line, [['/work/greet', '/sb/repo'], ['/work', '/sb']]))).toEqual({
      cwd: '/sb/repo',
      cmd: 'cd /sb/repo && ls',
      longer: '/sb/greeter-two',
      inside: '.github/workflows/ci.yml',
      nested: '/home/x/work/greet',
    });
  });

  test('maps a repository and its parent, longest first', () => {
    const line = JSON.stringify({
      cwd: 'C:\\dev',
      a: 'C:\\dev\\tool\\src\\x.ts',
      b: 'C:\\dev\\other\\y.ts',
      c: 'cd tool && git log',
    });
    const pairs = pathPairs(
      { repo: { recordedPath: 'C:\\dev\\tool' }, sessions: [{ cwd: 'C:\\dev' }] } as never,
      'D:\\sb\\work\\tool',
    );
    expect(pairs).toEqual([
      ['C:\\dev\\tool', 'D:\\sb\\work\\tool'],
      ['C:\\dev', 'D:\\sb\\work'],
    ]);
    expect(JSON.parse(rewritePaths(line, pairs))).toEqual({
      cwd: 'D:\\sb\\work',
      a: 'D:\\sb\\work\\tool\\src\\x.ts',
      b: 'D:\\sb\\work\\other\\y.ts',
      c: 'cd tool && git log',
    });
  });

  test('never maps a drive or filesystem root', () => {
    expect(pathPairs({ repo: {}, sessions: [{ cwd: 'C:\\repo' }] } as never, 'D:\\sb\\work\\repo')).toEqual([
      ['C:\\repo', 'D:\\sb\\work\\repo'],
    ]);
    expect(pathPairs({ repo: {}, sessions: [{ cwd: '/repo' }] } as never, '/sb/work/repo')).toEqual([['/repo', '/sb/work/repo']]);
  });

  test('maps a Windows recording onto a POSIX sandbox and its parent', () => {
    const pairs = pathPairs({ repo: { recordedPath: 'C:\\dev\\tool' } } as never, '/sb/work/tool');
    expect(pairs).toEqual([
      ['C:\\dev\\tool', '/sb/work/tool'],
      ['C:\\dev', '/sb/work'],
    ]);
    expect(JSON.parse(rewritePaths(JSON.stringify({ cwd: 'C:\\dev\\tool', parent: 'C:\\dev' }), pairs))).toEqual({ cwd: '/sb/work/tool', parent: '/sb/work' });
  });

  test('claudeProjectDir matches Claude Code naming', () => {
    expect(claudeProjectDir('C:\\Users\\cassandra\\Development\\tracetoon')).toBe('C--Users-cassandra-Development-tracetoon');
    expect(claudeProjectDir('/home/ada/my.repo')).toBe('-home-ada-my-repo');
  });
});

describe('createSandbox', () => {
  const loaded = loadCase(EXAMPLE);
  const { base, head } = loaded.case.repo;

  test('checks out the change as a feature branch off main', () => {
    const sb = createSandbox(loaded, { parent: tempDir() });
    try {
      expect(git(['rev-parse', 'HEAD'], sb.repo)).toBe(head!);
      expect(git(['branch', '--show-current'], sb.repo)).toBe('prbench/example-greet-default');
      expect(git(['rev-parse', 'main'], sb.repo)).toBe(base);
      expect(git(['rev-parse', 'origin/main'], sb.repo)).toBe(base);
      expect(git(['symbolic-ref', 'refs/remotes/origin/HEAD'], sb.repo)).toBe('refs/remotes/origin/main');
      expect(git(['rev-list', '--count', 'main..HEAD'], sb.repo)).toBe('1');
      expect(git(['status', '--porcelain'], sb.repo)).toBe('');
      expect(git(['for-each-ref', '--format=%(refname)'], sb.repo).split('\n').sort()).toEqual([
        'refs/heads/main',
        'refs/heads/prbench/example-greet-default',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      ]);
      // The git directory lives outside the checkout, so agents may write
      // there (Claude Code guards paths under .git/).
      expect(sb.gitDir).toBe(join(sb.root, 'git'));
      expect(git(['rev-parse', '--absolute-git-dir'], sb.repo).replace(/\//g, '\\').toLowerCase()).toBe(
        sb.gitDir.replace(/\//g, '\\').toLowerCase(),
      );
      expect(statSync(join(sb.repo, '.git')).isFile()).toBe(true);
    } finally {
      sb.dispose();
    }
  });

  test('places sessions where the agent looks and points them at the sandbox checkout', () => {
    const sb = createSandbox(loaded, { parent: tempDir() });
    try {
      expect(sb.sessions).toEqual([join(sb.home, '.claude', 'projects', claudeProjectDir(sb.repo), 'session.jsonl')]);
      const lines = readFileSync(sb.sessions[0]!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.every((l) => l.cwd === sb.repo)).toBe(true);
      const files = lines.flatMap((l) => Array.isArray(l.message?.content) ? l.message.content : [])
        .filter((part) => part.type === 'tool_use' && part.input?.file_path)
        .map((part) => part.input.file_path.replace(/\\/g, '/'));
      expect(files).toEqual(['greet.js', 'greet.js', 'greet.test.js'].map((name) => join(sb.repo, name).replace(/\\/g, '/')));
      expect(sb.env.HOME).toBe(sb.home);
      expect(sb.env.USERPROFILE).toBe(sb.home);
      expect(sb.env.CODEX_HOME).toBe(sb.codexHome);
      expect(sb.env.GH_TOKEN).toBeUndefined();
      for (const k of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) expect(sb.env[k]!.startsWith(sb.root)).toBe(true);
      expect(sb.repo).toBe(join(sb.root, 'work', 'greet'));
      expect(existsSync(join(sb.root, 'facts.json'))).toBe(false);
    } finally {
      sb.dispose();
    }
  });

  test.skipIf(process.platform !== 'win32')('PowerShell resolves home aliases inside the sandbox', () => {
    const sb = createSandbox(loaded, { parent: tempDir() });
    try {
      const powershell = Bun.which('pwsh.exe') ?? Bun.which('powershell.exe');
      expect(powershell).not.toBeNull();
      const r = exec([powershell!, '-NoProfile', '-Command', '[ordered]@{home=$HOME; envHome=$env:HOME; userProfile=$env:USERPROFILE; tilde=(Convert-Path ~)} | ConvertTo-Json -Compress'], { cwd: sb.repo, env: sb.env });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ home: sb.home, envHome: sb.home, userProfile: sb.home, tilde: sb.home });
    } finally {
      sb.dispose();
    }
  });

  test('captures PRs through a fake gh and sends pushes to a local remote', () => {
    const sb = createSandbox(loaded, { parent: tempDir() });
    try {
      const bodyFile = join(sb.root, 'body.md');
      writeFileSync(bodyFile, 'The body\n');
      const push = exec(['git', 'push', '--quiet', 'origin', sb.branch], { cwd: sb.repo, env: sb.env });
      expect(push.code).toBe(0);
      expect(git(['rev-parse', `refs/heads/${sb.branch}`], sb.remote)).toBe(head!);

      // The fetch URL looks like GitHub, but git may only use local repositories.
      const fetch = exec(['git', 'fetch', 'origin'], { cwd: sb.repo, env: sb.env });
      expect(fetch.code).not.toBe(0);
      expect(fetch.stderr).toMatch(/transport 'https' not allowed/);

      const r = gh(['pr', 'create', '--title', 'A title', '--body-file', bodyFile, '--base', 'main', '--draft'], sb.env, sb.repo);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('https://github.com/prbench-sandbox/example-greet-default/pull/1');
      expect(sb.capturedPRs()).toEqual([
        {
          number: 1,
          url: 'https://github.com/prbench-sandbox/example-greet-default/pull/1',
          title: 'A title',
          body: 'The body\n',
          base: 'main',
          draft: true,
        },
      ]);

      const second = gh(['pr', 'create', '--title=Again', '--body', 'inline'], sb.env, sb.repo);
      expect(second.stdout.trim()).toEndWith('/pull/2');
      expect(sb.capturedPRs()[1]).toMatchObject({ number: 2, title: 'Again', body: 'inline', draft: false });

      // Help never opens a PR (seen from a Codex writer: `gh pr create --help`).
      for (const help of [['pr', 'create', '--help'], ['pr', 'view', '-h'], ['help', 'pr']]) {
        const h = gh(help, sb.env, sb.repo);
        expect(h.code).toBe(0);
        expect(h.stdout).not.toContain('/pull/');
      }
      expect(sb.capturedPRs()).toHaveLength(2);
      expect(gh(['pr', 'create', '--title', 'Third'], sb.env, sb.repo).stdout.trim()).toEndWith('/pull/3');

      const odd = gh(['release', 'create', 'v1'], sb.env, sb.repo);
      expect(odd.code).toBe(1);
      expect(odd.stderr).toContain('unsupported command');
      expect(sb.ghCalls().at(-1)).toMatchObject({ args: ['release', 'create', 'v1'], ok: false, unsupported: true });
    } finally {
      sb.dispose();
    }
  });

  test('dispose removes everything, and a failed setup leaves nothing behind', () => {
    const parent = tempDir();
    const sb = createSandbox(loaded, { parent });
    sb.dispose();
    expect(existsSync(sb.root)).toBe(false);

    const broken = { ...loaded, case: { ...loaded.case, repo: { ...loaded.case.repo, head: 'f'.repeat(40) } } };
    expect(() => createSandbox(broken, { parent })).toThrow(/git checkout/);
    expect(readdirSync(parent)).toEqual([]);
  });
});

test('a Windows recorded path names the checkout by its last segment on any host', () => {
  // Public cases recorded on Windows (C:\prbench-replay\tracetoon) are replayed
  // on Linux; the checkout must not become one directory named "C:\...".
  const cases = copyExample('windows-recorded', (c) => {
    c.repo.recordedPath = 'C:\\prbench-replay\\greet';
  });
  const sb = createSandbox(loadCase(cases.dir), { parent: tempDir() });
  try {
    expect(sb.repo).toBe(join(sb.root, 'work', 'greet'));
    expect(readdirSync(join(sb.root, 'work'))).toEqual(['greet']);
  } finally {
    sb.dispose();
  }
});
