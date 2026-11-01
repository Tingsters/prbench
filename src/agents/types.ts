/** Provider-neutral terminal result used to build PR artifacts. */
export interface AgentRunResult {
  exitCode: number;
  timedOut: boolean;
  result?: string;
  isError: boolean;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  durationMs: number;
  stderr: string;
  cleanupTerminated?: boolean;
}
