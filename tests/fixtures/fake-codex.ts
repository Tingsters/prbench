// Test double: never contacts a model or records credential contents.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 9.8.7'); process.exit(0); }
const prompt = readFileSync(0, 'utf8');
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  args, prompt, home: process.env.HOME, codexHome: process.env.CODEX_HOME,
  authPresent: existsSync(join(process.env.CODEX_HOME!, 'auth.json')),
  apiKeyPresent: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
  authSourceVisible: Boolean(process.env.PRBENCH_CODEX_AUTH_HOME),
  tracetoonOff: process.env.TRACETOON, tracetoonConfig: process.env.TRACETOON_CONFIG,
  cwd: process.cwd(),
}) + '\n');

function sh(cmd: string[]): void {
  const proc = Bun.spawnSync(process.platform === 'win32' ? ['cmd', '/d', '/c', ...cmd] : cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode) throw new Error(proc.stderr.toString());
}

const mode = process.env.FAKE_CODEX_MODE ?? 'nothing';
if (mode === 'native' || mode === 'tracetoon') {
  console.log(JSON.stringify({ type: 'item.started', item: { id: 'fresh-check', type: 'command_execution', command: 'bun test', cwd: process.cwd(), status: 'in_progress' } }));
  await Bun.sleep(80);
  const check = Bun.spawnSync([process.execPath, 'test'], { stdout: 'pipe', stderr: 'pipe' });
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'fresh-check', type: 'command_execution', command: 'bun test', status: 'completed', exit_code: check.exitCode, aggregated_output: check.stdout.toString() + check.stderr.toString() } }));
}
if (mode === 'native') sh(['gh', 'pr', 'create', '--title', 'Codex fallback', '--body', 'Greets world by default.']);
if (mode === 'tracetoon') {
  const gitDir = Bun.spawnSync(['git', 'rev-parse', '--absolute-git-dir']).stdout.toString().trim();
  const runs = join(gitDir, 'tracetoon', 'runs');
  const run = '20260101-000000';
  mkdirSync(join(runs, run), { recursive: true });
  writeFileSync(join(runs, run, 'title.txt'), 'Codex Tracetoon fallback');
  writeFileSync(join(runs, run, 'final-body.md'), 'greet() falls back to world.');
  writeFileSync(join(runs, 'latest'), run);
}
if (mode === 'failed') {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'simulated provider failure' } }));
  process.exit(1);
}
if (args.includes('-o') && process.env.FAKE_CODEX_JUDGMENT) writeFileSync(args[args.indexOf('-o') + 1]!, process.env.FAKE_CODEX_JUDGMENT);
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } }));
