/** Provider-neutral terminal result used to build PR artifacts. */
import type { ValidationEvidence } from "../schema/validation.ts";

export interface AgentRunResult {
  exitCode: number;
  timedOut: boolean;
  result?: string;
  isError: boolean;
  costUsd?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** What the token counts cover: the main thread only, or every subagent thread too. */
  usageScope?: "main-thread" | "all-threads";
  /** Subagent threads included in the token counts. */
  subagentThreads?: number;
  numTurns?: number;
  durationMs: number;
  stageTimings?: Record<string, number>;
  stderr: string;
  cleanupTerminated?: boolean;
  rawExitCode?: number;
  validation?: ValidationEvidence;
}
