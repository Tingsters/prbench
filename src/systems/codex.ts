import { codexCommand } from '../agents/codexAuth.ts';
import { reasoningEffort, runCodex } from '../agents/codex.ts';
import { describeRun } from '../agents/claude.ts';
import { agentArtifact, claudeVersion, DEFAULT_AGENT_OPTIONS, PR_PROMPT, replaySupport, type AgentOptions } from './agentShared.ts';
import { installTracetoon, tracetoonDraft, tracetoonTimings, type PinnedTracetoon } from './tracetoon.ts';
import type { System } from './types.ts';

export const DEFAULT_CODEX_OPTIONS = {
  model: process.env.PRBENCH_CODEX_MODEL ?? 'gpt-6.1-sol',
  reasoningEffort: process.env.PRBENCH_CODEX_REASONING_EFFORT ?? 'medium',
  timeoutMs: DEFAULT_AGENT_OPTIONS.timeoutMs,
  maxBudgetUsd: undefined,
};

export function codexSystem(withTracetoon: boolean, options: Partial<AgentOptions> = {}, pinned?: PinnedTracetoon & { id?: string }): System {
  const o = { ...DEFAULT_CODEX_OPTIONS, ...options };
  const id = pinned?.id ?? (withTracetoon ? 'codex-tracetoon' : 'codex-native');
  return {
    id,
    description: withTracetoon ? 'Codex with Tracetoon installed (comics off; stops at preview).' : 'Codex asked to open a PR, without a PR tool (fresh session).',
    supports: replaySupport,
    async run({ loaded, sandbox, log }) {
      if (o.maxBudgetUsd !== undefined) throw new Error('Codex CLI has no USD spending-cap flag. Use --max-budget-usd none; runs share the configured timeout and reasoning effort.');
      const effort = reasoningEffort(o.reasoningEffort ?? 'medium');
      const started = Date.now();
      const tt = withTracetoon ? installTracetoon(sandbox, 'codex', pinned) : undefined;
      const installationMs = Date.now() - started, invocationStartedAt = Date.now();
      const run = await runCodex(sandbox, {
        prompt: PR_PROMPT, model: o.model, reasoningEffort: effort, timeoutMs: o.timeoutMs,
        env: tt?.env ?? { TRACETOON: '0' }, log,
      });
      const collectionStart = Date.now();
      const pr = sandbox.capturedPRs().at(-1);
      const draft = withTracetoon && !pr?.title ? tracetoonDraft(sandbox.gitDir, pinned ? { root: sandbox.repo, branch: sandbox.branch, startedAt: invocationStartedAt } : undefined) : undefined;
      if (!pr?.title && !draft) throw new Error(`${id} produced no PR${withTracetoon ? ' draft' : ''} (${describeRun(run)})`);
      const notes = ['Codex does not report USD cost or enforce a USD cap; both flows use the same timeout and reasoning effort.'];
      if (run.isError) notes.push(`agent reported an error: ${describeRun(run)}`);
      if (run.cleanupTerminated) notes.push('Codex reported turn completion; stopped lingering CLI background cleanup.');
      if (draft && !pr?.title) {
        notes.push(`tracetoon run ${draft.run}`);
        if (!draft.rendered) notes.push('Tracetoon did not render; body.md used');
        if (draft.state && !['ready', 'published'].includes(draft.state)) notes.push(`Tracetoon task is ${draft.state}; retained its available draft.`);
      }
      run.stageTimings = { ...run.stageTimings, installationMs, collectionMs: Date.now() - collectionStart };
      const artifact = agentArtifact({
        loaded, sandbox, system: id, tool: tt ? 'tracetoon' : 'codex-native',
        toolVersion: tt?.version ?? claudeVersion(sandbox.env, codexCommand()),
        agent: 'codex', model: o.model, reasoningEffort: effort,
        title: pr?.title ?? draft!.title, body: pr?.title ? pr.body ?? '' : draft!.body,
        run, startedAt: started, notes,
      });
      if (withTracetoon) {
        const timing = tracetoonTimings(sandbox.gitDir, { root: sandbox.repo, branch: sandbox.branch, startedAt: invocationStartedAt });
        artifact.meta.toolTimings = timing.entries;
        artifact.meta.toolTimingGaps = timing.gaps;
      }
      return artifact;
    },
  };
}
