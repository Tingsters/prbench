// Baseline: Claude Code's own "open a PR" flow, with no PR tool installed.
// It runs in a fresh session; the recorded sessions are on disk in the
// sandbox, as they would be on the user's machine, but nothing points the
// agent at them.
import { claudeCommand, describeRun, runClaude } from '../agents/claude.ts';
import {
  AGENT_TOOLS,
  DISALLOWED_TOOLS,
  agentArtifact,
  claudeVersion,
  DEFAULT_AGENT_OPTIONS,
  PR_PROMPT,
  replaySupport,
  type AgentOptions,
} from './agentShared.ts';
import type { System } from './types.ts';

export function claudeNative(options: Partial<AgentOptions> = {}): System {
  const o = { ...DEFAULT_AGENT_OPTIONS, ...options };
  return {
    id: 'claude-native',
    description: 'Claude Code asked to open a PR, with no PR tool installed (fresh session).',
    supports: replaySupport,
    async run({ loaded, sandbox, log }) {
      const started = Date.now();
      const run = await runClaude(sandbox, {
        prompt: PR_PROMPT,
        model: o.model,
        allowedTools: AGENT_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        maxBudgetUsd: o.maxBudgetUsd,
        timeoutMs: o.timeoutMs,
        env: { TRACETOON: '0' },
        log,
      });
      const pr = sandbox.capturedPRs().at(-1);
      if (!pr?.title) throw new Error(`claude-native opened no PR (${describeRun(run)})`);
      return agentArtifact({
        loaded,
        sandbox,
        system: 'claude-native',
        tool: 'claude-code-native',
        toolVersion: claudeVersion(sandbox.env, claudeCommand()),
        model: o.model,
        title: pr.title,
        body: pr.body ?? '',
        run,
        startedAt: started,
        notes: run.isError ? [`agent reported an error: ${describeRun(run)}`] : [],
      });
    },
  };
}
