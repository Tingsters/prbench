import type { Sandbox } from "../run/sandbox.ts";
import type { AgentRunResult } from "./types.ts";
import { codexCommand, codexRunEnv, withCodexAuth } from "./codexAuth.ts";
import { runAgentProcess } from "./process.ts";
import { startValidationCapture } from "./validation.ts";
import {
  codexRolloutSnapshot,
  codexUsageFromDir,
  type CodexUsage,
} from "./codexUsage.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function reasoningEffort(value: string): ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(value))
    throw new Error(`Unknown reasoning effort "${value}".`);
  return value as ReasoningEffort;
}

export interface CodexRunOptions {
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  env?: Record<string, string>;
  log?: (message: string) => void;
  /** Only this repository-local skill may be visible in a tool-enabled arm. */
  skillPath?: string;
}

export function codexSkillConfiguration(
  repo: string,
  skillPath?: string,
): string {
  const dirs = [
    join(homedir(), ".agents/skills/tracetoon"),
    join(homedir(), ".codex/skills/tracetoon"),
  ];
  if (!skillPath) dirs.push(join(repo, ".agents/skills/tracetoon"));
  const entries = dirs
    .flatMap((dir) => [join(dir, "SKILL.md"), dir])
    .map((path) => ({ path, enabled: false }));
  if (skillPath)
    entries.push({ path: join(skillPath, "SKILL.md"), enabled: true });
  return `skills.config=[${entries.map((e) => `{path=${JSON.stringify(e.path.replaceAll("\\", "/"))},enabled=${e.enabled}}`).join(",")}]`;
}

export function codexTerminalEvent(
  line: string,
): "success" | "failure" | undefined {
  try {
    const event = JSON.parse(line);
    if (event.type === "turn.completed") return "success";
    if (event.type === "turn.failed") return "failure";
  } catch {
    /* Diagnostics are not terminal events. */
  }
}

/** Consume terminal JSONL events, without retaining tool output or credentials. */
export function parseCodexResult(stdout: string): Partial<AgentRunResult> {
  let inputTokens = 0,
    outputTokens = 0,
    numTurns = 0;
  let cachedInputTokens = 0,
    cacheKnown = true,
    inputKnown = true,
    outputKnown = true;
  const known = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  let result: string | undefined;
  let isError = false;
  for (const line of stdout.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type === "item.completed" && e.item?.type === "agent_message")
        result = e.item.text;
      if (e.type === "turn.completed") {
        if (known(e.usage?.input_tokens)) inputTokens += e.usage.input_tokens;
        else inputKnown = false;
        if (known(e.usage?.cached_input_tokens))
          cachedInputTokens += e.usage.cached_input_tokens;
        else cacheKnown = false;
        if (known(e.usage?.output_tokens))
          outputTokens += e.usage.output_tokens;
        else outputKnown = false;
        numTurns++;
      }
      if (e.type === "turn.failed") {
        isError = true;
        result = e.error?.message ?? result;
      }
    } catch {
      /* Non-JSON diagnostics are not results. */
    }
  }
  return {
    result,
    isError,
    ...(numTurns
      ? {
          ...(inputKnown ? { inputTokens } : {}),
          ...(outputKnown ? { outputTokens } : {}),
          numTurns,
          ...(cacheKnown ? { cachedInputTokens } : {}),
        }
      : {}),
  };
}

function threadUsage(
  codexHome: string,
  prior: Set<string>,
): CodexUsage | undefined {
  try {
    return codexUsageFromDir(
      join(codexHome, "sessions"),
      (file) => !prior.has(file),
    );
  } catch {
    return undefined;
  }
}

/**
 * Stdout usage covers the main thread only; rollouts cover every thread the
 * run spawned. Prefer the rollouts when they hold at least the main thread's
 * usage, and say which scope the counts have.
 */
export function withThreadUsage(
  parsed: Partial<AgentRunResult>,
  usage: CodexUsage | undefined,
): Partial<AgentRunResult> {
  if (
    !usage ||
    (parsed.inputTokens !== undefined && usage.inputTokens < parsed.inputTokens)
  )
    return parsed.inputTokens === undefined
      ? parsed
      : { ...parsed, usageScope: "main-thread" };
  return {
    ...parsed,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    usageScope: "all-threads",
    subagentThreads: usage.subagentThreads,
  };
}

export async function runCodex(
  sandbox: Sandbox,
  opts: CodexRunOptions,
): Promise<AgentRunResult> {
  let authWaitMs = 0;
  return withCodexAuth(
    sandbox.codexHome,
    async () => {
      const started = Date.now();
      const cmd = [
        ...codexCommand(),
        "exec",
        "--ignore-user-config",
        "--json",
        "--color",
        "never",
        "--model",
        opts.model,
        "-c",
        `model_reasoning_effort="${opts.reasoningEffort}"`,
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'approval_policy="never"',
        "-c",
        'web_search="disabled"',
        "--sandbox",
        "danger-full-access",
        "--disable",
        "apps",
        "-c",
        "apps._default.enabled=false",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--enable",
        "skip_host_skill_discovery",
        "--disable",
        "remote_plugin",
        "-c",
        codexSkillConfiguration(sandbox.repo, opts.skillPath),
        "--enable",
        "hooks",
        "--dangerously-bypass-hook-trust",
        "--add-dir",
        sandbox.gitDir,
        "-",
      ];
      opts.log?.(
        `codex exec --model ${opts.model} --reasoning-effort ${opts.reasoningEffort}`,
      );
      const env = codexRunEnv({ ...sandbox.env, ...opts.env });
      const capture = startValidationCapture(sandbox, env);
      const priorRollouts = codexRolloutSnapshot(sandbox.codexHome);
      const executionStarted = performance.now();
      const result = await runAgentProcess(cmd, {
        cwd: sandbox.repo,
        env,
        prompt: opts.prompt,
        timeoutMs: opts.timeoutMs,
        terminalEvent: codexTerminalEvent,
        onLine: capture.line,
      });
      const writerMs = performance.now() - executionStarted,
        captureStarted = performance.now();
      const parsed = withThreadUsage(
          parseCodexResult(result.stdout),
          threadUsage(sandbox.codexHome, priorRollouts),
        ),
        validation = capture.finish(result);
      return {
        ...parsed,
        validation,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        cleanupTerminated: result.cleanupTerminated,
        rawExitCode: result.rawExitCode,
        isError: Boolean(parsed.isError || result.exitCode !== 0),
        durationMs: Date.now() - started,
        stageTimings: {
          authWaitMs,
          writerMs,
          collectionEvidenceMs: performance.now() - captureStarted,
        },
        stderr: result.stderr.slice(-4000),
      };
    },
    {
      onAcquired: (ms) => {
        authWaitMs = ms;
      },
    },
  );
}
