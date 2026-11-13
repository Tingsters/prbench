// Stands in for the GitHub CLI inside a sandbox. Every call is appended to
// $PRBENCH_GH_CAPTURE as one JSON line; `gh pr create` succeeds with a fake URL
// so the PR flow under test completes without anything reaching GitHub.
// Calls the fake doesn't understand fail loudly rather than pretend to work.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const capture = process.env.PRBENCH_GH_CAPTURE;
const slug = process.env.PRBENCH_GH_REPO ?? 'prbench-sandbox/case';

function flag(...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

function readBody(): string | undefined {
  const file = flag('--body-file', '-F');
  if (file === '-') return readFileSync(0, 'utf8');
  if (file) return readFileSync(file, 'utf8');
  return flag('--body', '-b');
}

function created(): unknown[] {
  if (!capture || !existsSync(capture)) return [];
  return readFileSync(capture, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.args[0] === 'pr' && e.args[1] === 'create' && e.ok && !e.help);
}

function record(entry: Record<string, unknown>): void {
  if (capture) appendFileSync(capture, JSON.stringify({ at: new Date().toISOString(), cwd: process.cwd(), args, ...entry }) + '\n');
}

function done(stdout: string, entry: Record<string, unknown> = {}): never {
  record({ ok: true, ...entry });
  process.stdout.write(stdout);
  process.exit(0);
}

const [a, b] = args;
// Help never acts, as with the real gh: `gh pr create --help` must not open a PR.
if (args.includes('--help') || args.includes('-h') || a === 'help')
  done(`gh ${args.filter((x) => !x.startsWith('-')).join(' ')}: help (prbench fake)\n`, { help: true });
if (a === '--version') done('gh version 2.99.0 (prbench fake)\n');
if (a === 'auth' && b === 'status') done('Logged in to github.com as prbench (fake)\n');
if (a === 'api' && b === 'user') done(args.includes('--jq') ? 'prbench\n' : '{"login":"prbench"}\n');
if (a === 'api' && b === `repos/${slug}`) {
  const repo = { allow_squash_merge: true, squash_merge_commit_title: 'PR_TITLE', default_branch: 'main', permissions: { push: true } };
  const query = flag('--jq');
  if (query === '[.allow_squash_merge, .squash_merge_commit_title] | @tsv') done('true\tPR_TITLE\n');
  if (!query) done(JSON.stringify(repo) + '\n');
}
if (a === 'repo' && b === 'view') {
  const json = flag('--json');
  if (!json) done(`${slug}\n`);
  const fields: Record<string, unknown> = {
    nameWithOwner: slug,
    visibility: 'PRIVATE',
    viewerPermission: 'WRITE',
    defaultBranchRef: { name: 'main' },
    isPrivate: true,
    url: `https://github.com/${slug}`,
  };
  const out: Record<string, unknown> = {};
  for (const f of json.split(',')) out[f] = fields[f] ?? null;
  done(JSON.stringify(out) + '\n');
}
// `--fill`, `--fill-first` and `--fill-verbose` take the title and body from
// the branch's commits, as the real gh does; explicit --title/--body win.
function commitsSince(base: string): { subject: string; body: string }[] {
  for (const ref of [base, `origin/${base}`]) {
    const r = spawnSync('git', ['log', '--reverse', '--no-merges', '--format=%s%x1f%b%x1e', `${ref}..HEAD`], { encoding: 'utf8' });
    if (r.status === 0)
      return r.stdout
        .split('\x1e')
        .map((c) => c.replace(/^\s+/, ''))
        .filter(Boolean)
        .map((c) => {
          const [subject = '', body = ''] = c.split('\x1f');
          return { subject: subject.trim(), body: body.trim() };
        });
  }
  return [];
}

function fill(): { title?: string; body?: string } {
  const mode = args.includes('--fill-first') ? 'first' : args.includes('--fill-verbose') ? 'verbose' : args.includes('--fill') || args.includes('-f') ? 'fill' : undefined;
  if (!mode) return {};
  const commits = commitsSince(flag('--base', '-B') ?? 'main');
  if (!commits.length) return {};
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (mode === 'first' || commits.length === 1) return { title: commits[0]!.subject, body: commits[0]!.body };
  if (mode === 'verbose')
    return { title: branch, body: commits.map((c) => `- **${c.subject}**${c.body ? `\n\n${c.body}` : ''}`).join('\n\n') };
  return { title: branch, body: commits.map((c) => `- ${c.subject}`).join('\n') };
}

if (a === 'pr' && b === 'create') {
  const number = created().length + 1;
  const url = `https://github.com/${slug}/pull/${number}`;
  const filled = fill();
  done(`${url}\n`, {
    pr: {
      number,
      url,
      title: flag('--title', '-t') ?? filled.title,
      body: readBody() ?? filled.body,
      base: flag('--base', '-B'),
      head: flag('--head', '-H'),
      draft: args.includes('--draft') || args.includes('-d'),
    },
  });
}
// No PR exists yet for the sandbox branch, so discovery calls find nothing.
if (a === 'pr' && b === 'list') done('[]\n');
if (a === 'pr' && b === 'view') {
  record({ ok: false });
  process.stderr.write('no pull requests found for branch (prbench fake)\n');
  process.exit(1);
}

record({ ok: false, unsupported: true });
process.stderr.write(`prbench fake gh: unsupported command: gh ${args.join(' ')}\n`);
process.exit(1);
