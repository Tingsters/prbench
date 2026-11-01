// Imports Tracetoon's description-eval cases as prbench replay cases.
//
//   bun run scripts/import-tracetoon-cases.ts [--tracetoon <repo>] [--out cases-local] [--only pr5,pr8]
//
// Each case gets:
//   repo.bundle    the repository up to the case's head commit
//   session-*.jsonl  the agent sessions Tracetoon matched to the change, cut to
//                  the case's time window: from an hour before the base commit
//                  to two minutes after the head commit. Cutting at the head
//                  commit keeps the PR text the agent wrote afterwards out of
//                  the logs, so no system can copy it.
//   facts.json     Tracetoon's hand-checked fact sheet
//   original.md    the PR that was published, when there is one
//
// The output holds real session logs, so it goes to cases-local/, which git
// ignores. Never commit it (see docs/cases.md).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CASE_SCHEMA, FACTS_SCHEMA, type Case, type CaseSession, type Facts } from '../src/schema/case.ts';
import { exec, git } from '../src/util/exec.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dev = resolve(homedir(), 'Development');
const tracetoon = resolve(arg('--tracetoon', join(dev, 'tracetoon'))!);
const out = resolve(arg('--out', resolve(import.meta.dir, '..', 'cases-local'))!);
const only = arg('--only')?.split(',');
const evalDir = join(tracetoon, '.git', 'tracetoon', 'eval-desc');

// The cases in Tracetoon's scripts/eval-descriptions.ts. Held-out cases were
// not looked at while Tracetoon's description rules were designed: they are
// prbench's test split.
const CASES = [
  { id: 'pr5', name: 'Summary evaluation and fixes', repo: 'tracetoon', base: 'a400a0774a', head: '2b22db920f', pr: 5 },
  { id: 'pr8', name: 'Clickable preview link + digest fixes', repo: 'tracetoon', base: 'c62818fbd7', head: 'c973ef3a07', pr: 8 },
  { id: 'pr9', name: 'AI-drawn comics', repo: 'tracetoon', base: 'c33c65b82f', head: '421ce024cc', pr: 9 },
  { id: 'pr11', name: 'Installer picks newest release', repo: 'tracetoon', base: '76fca1565a', head: 'd5935ebcd4', pr: 11 },
  { id: 'pr12', name: 'Quote-aware command splitting', repo: 'tracetoon', base: '0f850d80d5', head: '1b46c4c72f', pr: 12 },
  { id: 'pr10', name: 'Comic pages', repo: 'tracetoon', base: 'cfd0e3d26c', head: '85b4567087', pr: 10, heldOut: true },
  {
    id: 'showtail',
    name: 'Showtail library extraction',
    repo: 'Showtail',
    base: 'ce5b776',
    head: 'e74fd9a',
    heldOut: true,
    // Found on the first run: the baseline agent declined, rightly.
    excluded: "Showtail's CLAUDE.md forbids pull requests; work lands directly on main, so there is no PR to write.",
  },
  { id: 'vexaim', name: 'vexaim-cli Codex work', repo: 'vexaim-cli', base: '0723dbf^', head: '0723dbf', heldOut: true },
] as const;

const { scan } = (await import(join(tracetoon, 'src', 'pipeline.ts'))) as {
  scan: (cwd: string, opts: { base: string; head: string; noGh: boolean }) => {
    matches: { band: string; session: { agent: string; sessionId: string; source: string } }[];
  };
};

/** Largest first record a slice may start with (well under readers' 128 KB head window). */
const HEAD_LIMIT = 64 * 1024;

const commitTime = (repo: string, ref: string) => Number(git(['show', '-s', '--format=%ct', ref], repo)) * 1000;

/** Keeps lines timestamped inside [from, to]; Codex's session_meta line is always kept. */
function slice(text: string, from: number, to: number): { text: string; kept: number; cwd?: string } {
  const kept: string[] = [];
  let cwd: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: Record<string, any>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const isMeta = j.type === 'session_meta';
    const t = Date.parse(j.timestamp ?? '');
    if (!isMeta && !(t >= from && t <= to)) continue;
    // Readers find a session's working directory in the first records of the
    // file, reading only its first 128 KB (Showtail's agent-traces). A slice
    // that starts mid-session can open with one huge record, which hides the
    // whole file, so start at the first small record that names its cwd.
    if (kept.length === 0 && !isMeta && (line.length > HEAD_LIMIT || !(j.cwd ?? j.payload?.cwd))) continue;
    cwd ??= j.cwd ?? j.payload?.cwd;
    kept.push(line);
  }
  return { text: kept.join('\n') + '\n', kept: kept.length, cwd };
}

for (const c of CASES) {
  if (only && !only.includes(c.id)) continue;
  const repo = join(dev, c.repo);
  const dir = join(out, c.id);
  try {
    const base = git(['rev-parse', '--verify', `${c.base}^{commit}`], repo);
    const head = git(['rev-parse', '--verify', `${c.head}^{commit}`], repo);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // Bundle needs a ref; point a temporary one at head.
    const ref = `refs/prbench/import-${c.id}`;
    git(['update-ref', ref, head], repo);
    try {
      git(['bundle', 'create', '--quiet', join(dir, 'repo.bundle'), ref], repo);
    } finally {
      git(['update-ref', '-d', ref], repo);
    }

    const from = commitTime(repo, base) - 60 * 60_000;
    const to = commitTime(repo, head) + 2 * 60_000;
    const matches = scan(repo, { base, head, noGh: true }).matches.filter((m) => m.band === 'included');
    const sessions: CaseSession[] = [];
    for (const [i, m] of matches.entries()) {
      const agent = m.session.agent === 'codex' ? 'codex' : 'claude-code';
      const s = slice(readFileSync(m.session.source, 'utf8'), from, to);
      if (s.kept === 0 || !s.cwd) continue;
      const file = `session-${i + 1}-${agent}.jsonl`;
      writeFileSync(join(dir, file), s.text);
      sessions.push({ agent, file, cwd: s.cwd });
    }
    if (sessions.length === 0) throw new Error('no session records in the case window');

    const rawFacts = JSON.parse(readFileSync(join(evalDir, 'facts', `${c.id}.json`), 'utf8')) as Record<string, string[]>;
    const facts: Facts = {
      schema: FACTS_SCHEMA,
      claims: rawFacts.claims ?? [],
      context: rawFacts.context ?? [],
      uncertainties: rawFacts.uncertainties ?? [],
      traps: rawFacts.traps ?? [],
    };
    writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts, null, 2) + '\n');

    let original: Case['original'];
    if ('pr' in c) {
      const r = exec(['gh', 'pr', 'view', String(c.pr), '--repo', 'Tingsters/tracetoon', '--json', 'title,body,url']);
      if (r.code !== 0) throw new Error(`gh pr view ${c.pr}: ${r.stderr.trim()}`);
      const pr = JSON.parse(r.stdout) as { title: string; body: string; url: string };
      writeFileSync(join(dir, 'original.md'), pr.body.replace(/\r\n/g, '\n'));
      original = { title: pr.title, body: 'original.md', url: pr.url };
    }

    const kase: Case = {
      schema: CASE_SCHEMA,
      id: c.id,
      title: c.name,
      split: 'heldOut' in c && c.heldOut ? 'test' : 'dev',
      mode: 'replay',
      repo: { bundle: 'repo.bundle', base, head, recordedPath: repo },
      task: `The change that became ${c.repo}${'pr' in c ? ` PR #${c.pr}` : ''}: ${c.name}.`,
      sessions,
      facts: 'facts.json',
      ...(original ? { original } : {}),
      provenance: {
        source: `Tracetoon description eval (scripts/eval-descriptions.ts, case ${c.id})`,
        notes: `Sessions cut to ${new Date(from).toISOString()} – ${new Date(to).toISOString()}. Real session logs: keep local.`,
      },
      ...('excluded' in c ? { excluded: c.excluded } : {}),
    };
    writeFileSync(join(dir, 'case.json'), JSON.stringify(kase, null, 2) + '\n');
    const size = sessions.reduce((n, s) => n + readFileSync(join(dir, s.file)).length, 0);
    console.log(`ok    ${c.id}: ${sessions.length} session(s), ${(size / 1e6).toFixed(1)} MB, split ${kase.split}`);
  } catch (err) {
    console.log(`FAIL  ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
if (!existsSync(out)) console.log(`nothing written to ${basename(out)}`);
