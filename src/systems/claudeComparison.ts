// Claude Code arms of a frozen comparison. Mirrors codexSystem: the same PR
// request, the same unattended-workspace scope, and for Tracetoon arms only
// the pinned skill (sandbox ~/.claude/skills/tracetoon) and pinned runtime.
import {
  claudeCommand,
  claudeEffort,
  describeRun,
  runClaude,
} from "../agents/claude.ts";
import {
  AGENT_TOOLS,
  agentArtifact,
  claudeVersion,
  DISALLOWED_TOOLS,
  PR_PROMPT,
  replaySupport,
} from "./agentShared.ts";
import {
  installTracetoon,
  tracetoonDraft,
  tracetoonTimings,
  type PinnedTracetoon,
} from "./tracetoon.ts";
import type { System } from "./types.ts";

/**
 * Tools every Claude comparison arm may use. Tracetoon's workflow needs the
 * shell, the file tools, subagents (researcher, drafter, reviewer) and the
 * Skill tool; the native arm gets the same list so arms differ only in what
 * is installed. Web access is denied, like Codex's web_search="disabled".
 */
export const CLAUDE_COMPARISON_TOOLS = [...AGENT_TOOLS, "Skill", "TodoWrite"];
export const CLAUDE_COMPARISON_DISALLOWED = [
  ...DISALLOWED_TOOLS,
  "WebFetch",
  "WebSearch",
];

export function claudeComparisonSystem(
  withTracetoon: boolean,
  options: { model: string; effort: string; timeoutMs: number },
  pinned?: PinnedTracetoon & { id: string },
): System {
  const effort = claudeEffort(options.effort);
  const id = withTracetoon
    ? (pinned?.id ?? "claude-tracetoon")
    : "claude-native";
  return {
    id,
    description: withTracetoon
      ? "Claude Code with the pinned Tracetoon skill and runtime (comics off; stops at preview)."
      : "Claude Code asked to open a PR, without a PR tool (fresh session).",
    supports: replaySupport,
    async run({ loaded, sandbox, log }) {
      const started = Date.now();
      const tt = withTracetoon
        ? installTracetoon(sandbox, "claude-code", pinned)
        : undefined;
      const installationMs = Date.now() - started,
        invocationStartedAt = Date.now();
      const run = await runClaude(sandbox, {
        prompt: PR_PROMPT,
        model: options.model,
        effort,
        allowedTools: CLAUDE_COMPARISON_TOOLS,
        disallowedTools: CLAUDE_COMPARISON_DISALLOWED,
        addDirs: tt ? [sandbox.gitDir, tt.skill] : [sandbox.gitDir],
        timeoutMs: options.timeoutMs,
        env: tt?.env ?? { TRACETOON: "0" },
        log,
      });
      const collectionStart = Date.now();
      const pr = sandbox.capturedPRs().at(-1);
      const draft =
        withTracetoon && !pr?.title
          ? tracetoonDraft(
              sandbox.gitDir,
              pinned
                ? {
                    root: sandbox.repo,
                    branch: sandbox.branch,
                    startedAt: invocationStartedAt,
                  }
                : undefined,
            )
          : undefined;
      if (!pr?.title && !draft)
        throw new Error(
          `${id} produced no PR${withTracetoon ? " draft" : ""} (${describeRun(run)})`,
        );
      const notes = [
        "Claude Code runs without a USD cap; all arms share the configured timeout and effort.",
      ];
      if (run.isError)
        notes.push(`agent reported an error: ${describeRun(run)}`);
      if (run.cleanupTerminated)
        notes.push(
          "Claude Code reported its result; stopped lingering CLI background cleanup.",
        );
      if (draft && !pr?.title) {
        notes.push(`tracetoon run ${draft.run}`);
        if (!draft.rendered)
          notes.push("Tracetoon did not render; body.md used");
        if (draft.state && !["ready", "published"].includes(draft.state))
          notes.push(
            `Tracetoon task is ${draft.state}; retained its available draft.`,
          );
      }
      run.stageTimings = {
        ...run.stageTimings,
        installationMs,
        collectionMs: Date.now() - collectionStart,
      };
      const artifact = agentArtifact({
        loaded,
        sandbox,
        system: id,
        tool: tt ? "tracetoon" : "claude-code-native",
        toolVersion: tt?.version ?? claudeVersion(sandbox.env, claudeCommand()),
        agent: "claude-code",
        model: options.model,
        reasoningEffort: effort,
        title: pr?.title ?? draft!.title,
        body: pr?.title ? (pr.body ?? "") : draft!.body,
        run,
        startedAt: started,
        notes,
      });
      if (withTracetoon) {
        const timing = tracetoonTimings(sandbox.gitDir, {
          root: sandbox.repo,
          branch: sandbox.branch,
          startedAt: invocationStartedAt,
        });
        artifact.meta.toolTimings = timing.entries;
        artifact.meta.toolTimingGaps = timing.gaps;
        artifact.meta.operationCounts = timing.counts;
        artifact.meta.workflow = timing.workflow;
      }
      return artifact;
    },
  };
}
