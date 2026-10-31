// Builds cases/example-greet-default: a small synthetic replay case used by
// the tests and as a template for real cases. Commit dates and identities are
// fixed, so the commit SHAs are the same on every run.
//
//   bun run example
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CASE_SCHEMA, FACTS_SCHEMA, type Case, type Facts } from '../src/schema/case.ts';
import { exec } from '../src/util/exec.ts';

const ID = 'example-greet-default';
const CWD = '/work/greet';
const out = resolve(import.meta.dir, '..', 'cases', ID);

const work = mkdtempSync(join(tmpdir(), 'prbench-example-'));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(work, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Example Author',
  GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Example Author',
  GIT_COMMITTER_EMAIL: 'author@example.invalid',
};
writeFileSync(env.GIT_CONFIG_GLOBAL, '');

function git(args: string[], date?: string): string {
  const r = exec(['git', ...args], {
    cwd: join(work, 'repo'),
    env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env,
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const repo = join(work, 'repo');
mkdirSync(repo);
git(['init', '--quiet', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);

writeFileSync(join(repo, 'greet.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
writeFileSync(
  join(repo, 'greet.test.js'),
  "import { expect, test } from 'bun:test';\nimport { greet } from './greet.js';\n\ntest('greets by name', () => {\n  expect(greet('Ada')).toBe('Hello, Ada!');\n});\n",
);
git(['add', '-A']);
git(['commit', '--quiet', '-m', 'Add greet'], '2026-01-05T10:00:00Z');
const base = git(['rev-parse', 'HEAD']);

writeFileSync(
  join(repo, 'greet.js'),
  "export function greet(name) {\n  const who = typeof name === 'string' && name.trim() ? name.trim() : 'world';\n  return `Hello, ${who}!`;\n}\n",
);
writeFileSync(
  join(repo, 'greet.test.js'),
  "import { expect, test } from 'bun:test';\nimport { greet } from './greet.js';\n\ntest('greets by name', () => {\n  expect(greet('Ada')).toBe('Hello, Ada!');\n});\n\ntest('falls back to world without a usable name', () => {\n  expect(greet()).toBe('Hello, world!');\n  expect(greet('   ')).toBe('Hello, world!');\n});\n",
);
git(['add', '-A']);
git(['commit', '--quiet', '-m', "Greet 'world' when no name is given"], '2026-01-06T14:30:00Z');
const head = git(['rev-parse', 'HEAD']);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
git(['bundle', 'create', '--quiet', join(out, 'repo.bundle'), 'main']);

// A short Claude Code session in its JSONL format, recorded in CWD.
const sessionId = '00000000-0000-4000-8000-000000000001';
let t = Date.parse('2026-01-06T14:20:00Z');
const at = () => new Date((t += 15_000)).toISOString();
const line = (type: 'user' | 'assistant', content: unknown, uuid: number) =>
  JSON.stringify({ type, sessionId, cwd: CWD, gitBranch: `prbench/${ID}`, uuid: `u${uuid}`, timestamp: at(), message: { role: type, content } });
const session = [
  line('user', "greet() prints 'Hello, undefined!' when called without a name. Make it say 'Hello, world!' instead, and treat blank names the same way.", 1),
  line('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${CWD}/greet.js` } }], 2),
  line('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n' }], 3),
  line('assistant', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${CWD}/greet.js`, old_string: '  return `Hello, ${name}!`;', new_string: "  const who = typeof name === 'string' && name.trim() ? name.trim() : 'world';\n  return `Hello, ${who}!`;" } }], 4),
  line('user', [{ type: 'tool_result', tool_use_id: 't2', content: 'The file was updated.' }], 5),
  line('assistant', [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: `${CWD}/greet.test.js`, old_string: '', new_string: "test('falls back to world without a usable name', ...)" } }], 6),
  line('user', [{ type: 'tool_result', tool_use_id: 't3', content: 'The file was updated.' }], 7),
  line('assistant', [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'bun test', description: 'Run tests' } }], 8),
  line('user', [{ type: 'tool_result', tool_use_id: 't4', content: ' 2 pass\n 0 fail\nRan 2 tests across 1 file.' }], 9),
  line('assistant', [{ type: 'tool_use', id: 't5', name: 'Bash', input: { command: `git commit -am "Greet 'world' when no name is given"` } }], 10),
  line('user', [{ type: 'tool_result', tool_use_id: 't5', content: `[prbench/${ID} ${head.slice(0, 7)}] Greet 'world' when no name is given` }], 11),
  line('assistant', [{ type: 'text', text: "Done: greet() now falls back to 'world' for missing or blank names, with a test. Both tests pass." }], 12),
];
writeFileSync(join(out, 'session.jsonl'), session.join('\n') + '\n');

const facts: Facts = {
  schema: FACTS_SCHEMA,
  claims: [
    "greet() called without a name now returns 'Hello, world!' instead of 'Hello, undefined!'.",
    "Empty or whitespace-only names also fall back to 'world'.",
    'Names are trimmed before use, so greet(\'  Ada \') returns \'Hello, Ada!\'.',
    'A new test covers the no-name and blank-name cases.',
  ],
  context: ['The user reported that greet() printed "Hello, undefined!" and asked for "Hello, world!" for missing and blank names.'],
  uncertainties: ['The trimming of surrounding whitespace in real names is not covered by a test.'],
  traps: [
    'Claiming null is handled differently from other non-strings (it falls back to world like any non-string).',
    'Claiming the function throws or validates input types.',
    'Claiming the test suite was run in CI (it was only run locally, once, in the session: 2 pass, 0 fail).',
  ],
};
writeFileSync(join(out, 'facts.json'), JSON.stringify(facts, null, 2) + '\n');

writeFileSync(
  join(out, 'original.md'),
  "greet() returned 'Hello, undefined!' when called with no name. It now falls back to 'world' for missing or blank names.\n\nAdded a test for both cases; `bun test` passes locally.\n",
);

const c: Case = {
  schema: CASE_SCHEMA,
  id: ID,
  title: "Default greet() to 'world'",
  split: 'dev',
  mode: 'replay',
  repo: { bundle: 'repo.bundle', base, head },
  task: "greet() prints 'Hello, undefined!' when called without a name. Make it say 'Hello, world!' instead, and treat blank names the same way.",
  sessions: [{ agent: 'claude-code', file: 'session.jsonl', cwd: CWD }],
  facts: 'facts.json',
  original: { title: "Greet 'world' when no name is given", body: 'original.md' },
  provenance: { source: 'scripts/make-example.ts', synthetic: true, notes: 'Synthetic case for tests and as a template.' },
};
writeFileSync(join(out, 'case.json'), JSON.stringify(c, null, 2) + '\n');

rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(`wrote ${out} (base ${base.slice(0, 7)}, head ${head.slice(0, 7)})`);
