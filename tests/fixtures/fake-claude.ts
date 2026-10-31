// Stands in for `claude -p` in tests. Records how it was called, then acts out
// one of two endings, chosen by FAKE_CLAUDE_MODE:
//   native     push the branch and open a PR through `gh` (found on PATH)
//   tracetoon  leave a Tracetoon run folder with a rendered draft
//   nothing    do nothing
// Prints a result object like `claude -p --output-format json` does.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  appendFileSync(
    log,
    JSON.stringify({
      args,
      prompt,
      cwd: process.cwd(),
      home: process.env.HOME,
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      tracetoonOff: process.env.TRACETOON,
      tracetoonConfig: process.env.TRACETOON_CONFIG,
    }) + '\n',
  );
}
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

function sh(cmd: string[]): void {
  const shell = process.platform === 'win32' ? ['cmd', '/d', '/c', ...cmd] : cmd;
  const r = Bun.spawnSync(shell, { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    process.stderr.write(`${cmd.join(' ')} failed: ${r.stderr.toString()}`);
    process.exit(1);
  }
}

const mode = process.env.FAKE_CLAUDE_MODE ?? 'nothing';
if (mode === 'native') {
  sh(['git', 'push', '--quiet', '-u', 'origin', 'HEAD']);
  sh(['gh', 'pr', 'create', '--title', 'Fallback to world', '--body', 'Greets world when no name is given.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)']);
}
if (mode === 'tracetoon') {
  const gitDir = Bun.spawnSync(['git', 'rev-parse', '--absolute-git-dir']).stdout.toString().trim();
  const runs = join(gitDir, 'tracetoon', 'runs');
  const run = '20260101-000000';
  mkdirSync(join(runs, run), { recursive: true });
  writeFileSync(join(runs, run, 'title.txt'), "Greet 'world' when no name is given\n");
  writeFileSync(
    join(runs, run, 'final-body.md'),
    '<!-- tracetoon:start -->\ngreet() now falls back to world.\n\n<sub>Assisted-by: Claude Code</sub>\n<!-- tracetoon:end -->\n',
  );
  writeFileSync(join(runs, 'latest'), run);
}
process.stdout.write(
  JSON.stringify({ type: 'result', is_error: false, result: `done (${mode})`, total_cost_usd: 0.42, num_turns: 3, usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 } }) + '\n',
);
