// Claude Code with Tracetoon installed, asked to open a PR the same way as the
// baseline. Tracetoon's hook stops `gh pr create` and its skill takes over;
// the flow ends at a local preview waiting for the author's approval, so the
// PR text is read from Tracetoon's run folder (title.txt, final-body.md).
// Comics are turned off: they're judged separately, if at all.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeRun, runClaude } from '../agents/claude.ts';
import type { Sandbox } from '../run/sandbox.ts';
import { exec } from '../util/exec.ts';
import { AGENT_TOOLS, agentArtifact, DISALLOWED_TOOLS, DEFAULT_AGENT_OPTIONS, PR_PROMPT, replaySupport, type AgentOptions } from './agentShared.ts';
import type { System } from './types.ts';

export function tracetoonCommand(env: Record<string, string | undefined> = process.env): string[] {
  return env.PRBENCH_TRACETOON_COMMAND ? (JSON.parse(env.PRBENCH_TRACETOON_COMMAND) as string[]) : ['tracetoon'];
}

export function tracetoonSkillDir(env: Record<string, string | undefined> = process.env): string {
  return env.PRBENCH_TRACETOON_SKILL ?? join(homedir(), '.claude', 'skills', 'tracetoon');
}

/** Installs the skill, hooks and a comic-free config into the sandbox's home. Returns extra env for the run. */
export function installTracetoon(sandbox: Sandbox): { env: Record<string, string>; version?: string; skill: string } {
  const source = tracetoonSkillDir();
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`Tracetoon skill not found at ${source} (set PRBENCH_TRACETOON_SKILL)`);
  const skill = join(sandbox.home, '.claude', 'skills', 'tracetoon');
  cpSync(source, skill, { recursive: true });

  const config = join(sandbox.root, 'tracetoon-config.json');
  writeFileSync(config, JSON.stringify({ comic: 'off' }, null, 2) + '\n');
  const env = { TRACETOON_CONFIG: config };

  const r = exec([...tracetoonCommand(), 'hook', 'install'], { env: { ...sandbox.env, ...env }, cwd: sandbox.repo });
  if (r.code !== 0) throw new Error(`tracetoon hook install failed: ${(r.stderr || r.stdout).trim()}`);
  if (!existsSync(join(sandbox.home, '.claude', 'settings.json'))) {
    throw new Error('tracetoon hook install did not write the sandbox settings (it may have used the real home directory)');
  }
  const versionFile = join(skill, 'VERSION');
  const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined;
  return { env, version, skill };
}

/** The PR text in Tracetoon's newest run folder (under the git directory), if it got that far. */
export function tracetoonDraft(gitDir: string): { title: string; body: string; rendered: boolean; run: string } | undefined {
  const runs = join(gitDir, 'tracetoon', 'runs');
  const latest = join(runs, 'latest');
  if (!existsSync(latest)) return undefined;
  const run = readFileSync(latest, 'utf8').trim();
  const dir = join(runs, run);
  const titleFile = join(dir, 'title.txt');
  const final = join(dir, 'final-body.md');
  const draft = join(dir, 'body.md');
  if (!existsSync(titleFile) || !(existsSync(final) || existsSync(draft))) return undefined;
  const rendered = existsSync(final);
  return {
    title: readFileSync(titleFile, 'utf8').trim(),
    body: readFileSync(rendered ? final : draft, 'utf8'),
    rendered,
    run,
  };
}

export function tracetoonSystem(options: Partial<AgentOptions> = {}): System {
  const o = { ...DEFAULT_AGENT_OPTIONS, ...options };
  return {
    id: 'tracetoon',
    description: 'Claude Code with Tracetoon installed, asked to open a PR (comics off; stops at the preview).',
    supports: replaySupport,
    async run({ loaded, sandbox, log }) {
      const started = Date.now();
      const tt = installTracetoon(sandbox);
      const run = await runClaude(sandbox, {
        prompt: PR_PROMPT,
        model: o.model,
        allowedTools: AGENT_TOOLS,
        // Like the baseline, plus the skill folder, which lies outside the
        // working directory.
        addDirs: [sandbox.gitDir, tt.skill],
        disallowedTools: DISALLOWED_TOOLS,
        maxBudgetUsd: o.maxBudgetUsd,
        timeoutMs: o.timeoutMs,
        env: tt.env,
        log,
      });

      const notes: string[] = [];
      if (run.isError) notes.push(`agent reported an error: ${describeRun(run)}`);
      const published = sandbox.capturedPRs().at(-1);
      const draft = tracetoonDraft(sandbox.gitDir);
      let title: string;
      let body: string;
      if (published?.title) {
        title = published.title;
        body = published.body ?? '';
        notes.push('PR was opened through gh');
      } else if (draft) {
        title = draft.title;
        body = draft.body;
        if (!draft.rendered) notes.push('Tracetoon did not render; body.md used');
        notes.push(`tracetoon run ${draft.run}`);
      } else {
        throw new Error(`tracetoon produced no PR draft (${describeRun(run)})`);
      }
      return agentArtifact({
        loaded,
        sandbox,
        system: 'tracetoon',
        tool: 'tracetoon',
        toolVersion: tt.version,
        model: o.model,
        title,
        body,
        run,
        startedAt: started,
        notes,
      });
    },
  };
}

