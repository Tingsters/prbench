import { ARTIFACT_SCHEMA, type PRArtifact } from '../schema/artifact.ts';
import type { LoadedCase } from '../schema/case.ts';
import { commitsBetween, diffBetween, resolveRef } from '../run/gitFacts.ts';
import type { Sandbox } from '../run/sandbox.ts';
import type { ClaudeRunResult } from '../agents/claude.ts';
import { exec } from '../util/exec.ts';

/**
 * What every agent system is asked, word for word. Systems differ only in
 * what is installed around the agent, so the request itself is held fixed.
 */
export const PR_PROMPT = 'The work on this branch is done. Open a pull request for it.';

/**
 * Tools every agent system may use without asking; anything else is denied.
 * The list is the same for every system so they differ only in what is
 * installed. (`tracetoon` rules do nothing where Tracetoon isn't installed.)
 */
export const AGENT_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Agent',
  'Task',
  'Bash(git:*)',
  'Bash(gh:*)',
  'Bash(tracetoon:*)',
  'Bash(~/.claude/skills/tracetoon/bin/tracetoon:*)',
  'Bash($HOME/.claude/skills/tracetoon/bin/tracetoon:*)',
];

export interface AgentOptions {
  model: string;
  /** Spending cap per run; undefined means no cap. */
  maxBudgetUsd?: number;
  timeoutMs: number;
}

/** "none" (or "0") means no cap; anything else must be a positive number of dollars. */
export function parseBudget(value: string): number | undefined {
  if (value === 'none' || value === '0') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`budget must be a number of dollars or "none", got "${value}"`);
  return n;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  model: process.env.PRBENCH_MODEL ?? 'opus',
  maxBudgetUsd: parseBudget(process.env.PRBENCH_MAX_BUDGET_USD ?? '25'),
  timeoutMs: Number(process.env.PRBENCH_TIMEOUT_MS ?? 45 * 60_000),
};

export function replaySupport(loaded: LoadedCase): { supported: true } | { supported: false; reason: string } {
  if (loaded.case.mode !== 'replay' || !loaded.case.repo.head) return { supported: false, reason: 'needs a replay case' };
  if (!loaded.case.sessions?.some((s) => s.agent === 'claude-code' || s.agent === 'codex')) {
    return { supported: false, reason: 'case has no recorded sessions' };
  }
  return { supported: true };
}

export function claudeVersion(env: Record<string, string>, command: string[]): string | undefined {
  const r = exec([...command, '--version'], { env });
  return r.code === 0 ? r.stdout.trim().split(/\s+/)[0] : undefined;
}

/**
 * Builds the artifact from what the agent left behind: its PR text, plus the
 * commits and diff now on the work branch (the agent may have added commits).
 */
export function agentArtifact(opts: {
  loaded: LoadedCase;
  sandbox: Sandbox;
  system: string;
  tool: string;
  toolVersion?: string;
  model: string;
  title: string;
  body: string;
  run: ClaudeRunResult;
  startedAt: number;
  notes?: string[];
}): PRArtifact {
  const { sandbox } = opts;
  const base = resolveRef(sandbox.repo, opts.loaded.case.repo.base);
  const head = resolveRef(sandbox.repo, sandbox.branch);
  const notes = [...(opts.notes ?? [])];
  if (head !== resolveRef(sandbox.repo, opts.loaded.case.repo.head!)) notes.push('the agent changed the branch');
  const unsupported = sandbox.ghCalls().filter((c) => c.unsupported);
  if (unsupported.length) notes.push(`unsupported gh calls: ${unsupported.map((c) => c.args.join(' ')).join('; ')}`);
  return {
    schema: ARTIFACT_SCHEMA,
    case: opts.loaded.case.id,
    system: opts.system,
    title: opts.title.trim(),
    body: opts.body,
    base,
    head,
    commits: commitsBetween(sandbox.repo, base, head),
    diff: diffBetween(sandbox.repo, base, head),
    meta: {
      tool: opts.tool,
      ...(opts.toolVersion ? { toolVersion: opts.toolVersion } : {}),
      agent: 'claude-code',
      model: opts.model,
      startedAt: new Date(opts.startedAt).toISOString(),
      durationMs: Date.now() - opts.startedAt,
      ...(opts.run.costUsd !== undefined ? { costUsd: opts.run.costUsd } : {}),
      ...(opts.run.inputTokens !== undefined ? { inputTokens: opts.run.inputTokens } : {}),
      ...(opts.run.outputTokens !== undefined ? { outputTokens: opts.run.outputTokens } : {}),
      ...(notes.length ? { notes } : {}),
    },
  };
}
