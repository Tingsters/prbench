// Stands in for `claude -p` in tests. Records how it was called, then acts out
// one of several endings, chosen by FAKE_CLAUDE_MODE:
//   native      push the branch and open a PR through `gh` (found on PATH)
//   tracetoon   leave a Tracetoon run folder with a rendered draft
//   comparison  like a frozen-comparison writer: Tracetoon arms (TRACETOON_CONFIG
//               set) register an invocation-owned task with timings, then every
//               arm opens its PR through `gh`
//   nothing     do nothing
// Two modes are detected instead of chosen:
//   judge       --json-schema was passed: reply with FAKE_CLAUDE_JUDGMENT as
//               structured_output (no transcript, like --no-session-persistence)
//   isolation   the prompt is the isolation probe: report the Tracetoon skill in
//               the init event's catalogue and answer with its SKILL.md path or NONE
// Prints stream-json events (a system/init event first, a result event last),
// and persists a transcript under $HOME/.claude/projects like Claude Code does.
// FAKE_CLAUDE_DELAY_MS delays the reply; FAKE_CLAUDE_LOG gets one JSON line per
// call with {pid, start, end} so tests can measure concurrency.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const start = Date.now();
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
const log = process.env.FAKE_CLAUDE_LOG;
const record = () => {
  if (!log) return;
  appendFileSync(
    log,
    JSON.stringify({
      args,
      prompt,
      cwd: process.cwd(),
      home: process.env.HOME,
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      apiKey: process.env.ANTHROPIC_API_KEY,
      inheritedClaudeEnv: Object.keys(process.env).filter(
        (k) => /^(ANTHROPIC_|CLAUDE_CODE_)/i.test(k) || k.toUpperCase() === 'CLAUDECODE',
      ),
      tracetoonOff: process.env.TRACETOON,
      tracetoonConfig: process.env.TRACETOON_CONFIG,
      pid: process.pid,
      start,
      end: Date.now(),
    }) + '\n',
  );
};
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
if (delay > 0) await Bun.sleep(delay);

const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = randomUUID();

// Judge: --output-format json prints one result object.
if (args.includes('--json-schema')) {
  record();
  const judgment = process.env.FAKE_CLAUDE_JUDGMENT;
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: judgment ?? '',
      ...(judgment ? { structured_output: JSON.parse(judgment) } : {}),
      total_cost_usd: 0.01,
    }) + '\n',
  );
  process.exit(0);
}

const transcript: string[] = [];
const emit = (event: Record<string, unknown>) => {
  const line = JSON.stringify(event);
  console.log(line);
  if (event.type !== 'system' && event.type !== 'result')
    transcript.push(JSON.stringify({ ...event, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() }));
};
const persist = () => {
  if (args.includes('--no-session-persistence') || !transcript.length) return;
  const dir = join(process.env.HOME!, '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), transcript.join('\n') + '\n');
};

const userSkill = join(process.env.HOME!, '.claude', 'skills', 'tracetoon', 'SKILL.md');
const skills = existsSync(userSkill) ? ['tracetoon'] : [];
if (process.env.FAKE_CLAUDE_EXTRA_SKILL) skills.push(process.env.FAKE_CLAUDE_EXTRA_SKILL);
emit({
  type: 'system',
  subtype: 'init',
  cwd: process.cwd(),
  session_id: sessionId,
  model: flag('--model'),
  permissionMode: flag('--permission-mode'),
  tools: flag('--tools') === undefined ? ['Bash', 'Read', 'Skill'] : (flag('--tools') || '').split(',').filter(Boolean),
  mcp_servers: process.env.FAKE_CLAUDE_MCP ? [{ name: process.env.FAKE_CLAUDE_MCP, status: 'connected' }] : [],
  slash_commands: ['compact', ...skills],
  skills,
  plugins: [],
});

function sh(cmd: string[]): void {
  const shell = process.platform === 'win32' ? ['cmd', '/d', '/c', ...cmd] : cmd;
  const r = Bun.spawnSync(shell, { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    process.stderr.write(`${cmd.join(' ')} failed: ${r.stderr.toString()}`);
    process.exit(1);
  }
}

const finish = (result: string, isError = false) => {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } });
  persist();
  record();
  process.stdout.write(
    JSON.stringify({ type: 'result', is_error: isError, result, total_cost_usd: 0.42, num_turns: 3, usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 } }) + '\n',
  );
  process.exit(isError ? 1 : 0);
};

if (prompt.startsWith('Without running any tools, print the absolute path')) {
  if (process.env.FAKE_CLAUDE_PROBE_TOOL === '1')
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'probe', name: 'Skill', input: { skill: 'tracetoon' } }] } });
  finish(process.env.FAKE_CLAUDE_PROBE_REPLY ?? (skills.includes('tracetoon') ? userSkill : 'NONE'));
}

const mode = process.env.FAKE_CLAUDE_MODE ?? 'nothing';
if (mode === 'native' || mode === 'tracetoon' || mode === 'comparison') {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fresh-check', name: 'Bash', input: { command: 'bun test', cwd: process.cwd() } }] } });
  await Bun.sleep(80);
  const check = Bun.spawnSync([process.execPath, 'test'], { stdout: 'pipe', stderr: 'pipe' });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fresh-check', is_error: check.exitCode !== 0, content: check.stdout.toString() + check.stderr.toString() }] } });
}
if (mode === 'comparison' && process.env.TRACETOON_CONFIG) {
  const gitDir = Bun.spawnSync(['git', 'rev-parse', '--absolute-git-dir']).stdout.toString().trim();
  const branch = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.toString().trim();
  const run = join(gitDir, 'tracetoon', 'runs', '20260101-000000');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'task.json'), JSON.stringify({ root: process.cwd(), branch, startedAt: new Date().toISOString() }));
  writeFileSync(join(run, 'timings.json'), JSON.stringify([{ stage: 'digest', durationMs: 7 }, { stage: 'context', durationMs: 3 }]));
}
if (mode === 'native') {
  sh(['git', 'push', '--quiet', '-u', 'origin', 'HEAD']);
  sh(['gh', 'pr', 'create', '--title', 'Fallback to world', '--body', 'Greets world when no name is given.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)']);
}
if (mode === 'comparison') sh(['gh', 'pr', 'create', '--title', 'Claude fallback', '--body', 'Greets world by default.']);
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
if (mode === 'linger') {
  // Prints its result, then keeps running like CLI background cleanup.
  record();
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done (linger)', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
  await Bun.sleep(60_000);
  process.exit(0);
}
finish(`done (${mode})`);
