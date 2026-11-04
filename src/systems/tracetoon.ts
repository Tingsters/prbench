// Claude Code with Tracetoon installed, asked to open a PR the same way as the
// baseline. Tracetoon's hook stops `gh pr create` and its skill takes over;
// the flow ends at a local preview waiting for the author's approval, so the
// PR text is read from Tracetoon's run folder (title.txt, final-body.md).
// Comics are turned off: they're judged separately, if at all.
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeRun, runClaude } from "../agents/claude.ts";
import type { Sandbox } from "../run/sandbox.ts";
import { exec } from "../util/exec.ts";
import { currentTracetoonReview } from "./tracetoonReview.ts";
import {
  AGENT_TOOLS,
  agentArtifact,
  DISALLOWED_TOOLS,
  DEFAULT_AGENT_OPTIONS,
  PR_PROMPT,
  replaySupport,
  type AgentOptions,
} from "./agentShared.ts";
import type { System } from "./types.ts";

export function tracetoonCommand(
  env: Record<string, string | undefined> = process.env,
  skill?: string,
): string[] {
  if (env.PRBENCH_TRACETOON_COMMAND)
    return JSON.parse(env.PRBENCH_TRACETOON_COMMAND) as string[];
  if (skill && existsSync(join(skill, "dist", "tracetoon.mjs")))
    return [process.execPath, join(skill, "dist", "tracetoon.mjs")];
  return ["tracetoon"];
}

export function tracetoonSkillDir(
  env: Record<string, string | undefined> = process.env,
  agent: "claude-code" | "codex" = "claude-code",
): string {
  return (
    env.PRBENCH_TRACETOON_SKILL ??
    join(
      homedir(),
      agent === "codex" ? ".agents" : ".claude",
      "skills",
      "tracetoon",
    )
  );
}

/** Installs the skill, hooks and a comic-free config into the sandbox's home. Returns extra env for the run. */
export interface PinnedTracetoon {
  skill: string;
  runtime: string;
}
export function installTracetoon(
  sandbox: Sandbox,
  agent: "claude-code" | "codex" = "claude-code",
  pinned?: PinnedTracetoon,
): { env: Record<string, string>; version?: string; skill: string } {
  const source = pinned?.skill ?? tracetoonSkillDir(process.env, agent);
  if (!existsSync(join(source, "SKILL.md")))
    throw new Error(
      `Tracetoon skill not found at ${source} (set PRBENCH_TRACETOON_SKILL)`,
    );
  const skill = join(
    agent === "codex" ? sandbox.repo : sandbox.home,
    agent === "codex" ? ".agents" : ".claude",
    "skills",
    "tracetoon",
  );
  if (existsSync(skill))
    throw new Error(
      "The case already contains a Tracetoon skill; refusing to shadow case inputs.",
    );
  cpSync(source, skill, { recursive: true });
  if (agent === "codex") {
    const exclude = join(sandbox.gitDir, "info", "exclude");
    writeFileSync(
      exclude,
      (existsSync(exclude) ? readFileSync(exclude, "utf8") : "") +
        "\n/.agents/skills/tracetoon/\n",
    );
  }
  const pinnedRuntime = pinned
    ? join(
        sandbox.bin,
        `tracetoon${process.platform === "win32" ? ".exe" : ""}`,
      )
    : undefined;
  if (pinnedRuntime) cpSync(pinned!.runtime, pinnedRuntime);

  const config = join(sandbox.root, "tracetoon-config.json");
  writeFileSync(config, JSON.stringify({ comic: "off" }, null, 2) + "\n");
  const env: Record<string, string> = {
    TRACETOON_CONFIG: config,
    TRACETOON_ASSETS: join(skill, "assets"),
    TRACETOON_LAUNCHER: join(
      skill,
      "bin",
      process.platform === "win32" ? "tracetoon.cmd" : "tracetoon",
    ),
    ...(pinnedRuntime
      ? { TRACETOON_BIN: pinnedRuntime, TRACETOON_ALLOW_DOWNLOAD: "0" }
      : {}),
  };

  const r = exec(
    [
      ...(pinnedRuntime
        ? [pinnedRuntime]
        : tracetoonCommand(process.env, skill)),
      "hook",
      "install",
    ],
    { env: { ...sandbox.env, ...env }, cwd: sandbox.repo },
  );
  if (r.code !== 0)
    throw new Error(
      `tracetoon hook install failed: ${(r.stderr || r.stdout).trim()}`,
    );
  const hooks =
    agent === "codex"
      ? join(sandbox.codexHome, "hooks.json")
      : join(sandbox.home, ".claude", "settings.json");
  if (!existsSync(hooks)) {
    throw new Error(
      "tracetoon hook install did not write the sandbox hooks (it may have used the real home directory)",
    );
  }
  if (pinnedRuntime) {
    const commands = (value: any): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([k, v]) =>
            k === "command" && typeof v === "string" ? [v] : commands(v),
          )
        : [];
    const normalized = pinnedRuntime.replace(/\\/g, "/");
    if (
      !commands(JSON.parse(readFileSync(hooks, "utf8"))).some((c) =>
        c.replace(/\\/g, "/").includes(normalized),
      )
    )
      throw new Error("Sandbox hook does not use the pinned runtime.");
  }
  const versionFile = join(skill, "VERSION");
  const version = existsSync(versionFile)
    ? readFileSync(versionFile, "utf8").trim()
    : undefined;
  return { env, version, skill };
}

/** Prefer the selected run, falling back to recent drafts if a later empty run hides them. */
export function tracetoonDraft(
  gitDir: string,
  invocation?: { root: string; branch: string; startedAt: number },
):
  | {
      title: string;
      body: string;
      rendered: boolean;
      run: string;
      state?: string;
    }
  | undefined {
  const runs = join(gitDir, "tracetoon", "runs");
  if (!existsSync(runs)) return undefined;
  const latest = join(runs, "latest");
  const selected = existsSync(latest)
    ? readFileSync(latest, "utf8").trim()
    : "";
  const recent = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const candidates = [];
  for (const run of new Set([selected, ...recent].filter(Boolean))) {
    const dir = join(runs, run);
    const titleFile = join(dir, "title.txt");
    const final = join(dir, "final-body.md");
    const draft = join(dir, "body.md");
    if (!existsSync(titleFile) || !(existsSync(final) || existsSync(draft)))
      continue;
    const rendered = existsSync(final);
    const taskFile = join(dir, "task.json");
    const task = existsSync(taskFile)
      ? (JSON.parse(readFileSync(taskFile, "utf8")) as {
          state?: string;
          root?: string;
          branch?: string;
          startedAt?: string;
        })
      : undefined;
    if (
      invocation &&
      (!task ||
        task.root !== invocation.root ||
        task.branch !== invocation.branch ||
        !Number.isFinite(Date.parse(task.startedAt ?? "")) ||
        Date.parse(task.startedAt!) < invocation.startedAt)
    )
      continue;
    candidates.push({
      title: readFileSync(titleFile, "utf8").trim(),
      body: readFileSync(rendered ? final : draft, "utf8"),
      rendered,
      run,
      state: task?.state,
    });
  }
  if (invocation && candidates.length > 1)
    throw new Error(
      "More than one draft belongs to this invocation; select an explicit run rather than guessing.",
    );
  return candidates[0];
}

/** Retain self-reported stage timings before the sandbox is removed; unknown stays explicit. */
export function tracetoonTimings(
  gitDir: string,
  invocation: { root: string; branch: string; startedAt: number },
) {
  const entries: { stage: string; durationMs: number }[] = [],
    gaps: string[] = [];
  const counts: Record<string, number> = {},
    seen = new Set<string>();
  let workflow:
    | {
        declaredIndependentRoles: number;
        reviewCurrent: boolean;
        reviewVersion?: number;
        limitations: string[];
      }
    | undefined;
  const runs = join(gitDir, "tracetoon", "runs");
  const headSha = exec([
    "git",
    "--git-dir",
    gitDir,
    "rev-parse",
    "HEAD",
  ]).stdout.trim();
  if (existsSync(runs))
    for (const dir of readdirSync(runs, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^\d{8}-\d{6}(-\d+)?$/.test(dir.name))
        continue;
      const root = join(runs, dir.name),
        task = join(root, "task.json");
      if (!existsSync(task)) continue;
      try {
        const t = JSON.parse(readFileSync(task, "utf8"));
        if (
          t.root !== invocation.root ||
          t.branch !== invocation.branch ||
          !Number.isFinite(Date.parse(t.startedAt)) ||
          Date.parse(t.startedAt) < invocation.startedAt
        )
          continue;
        const profileFile = join(root, "profiles.jsonl");
        if (existsSync(profileFile))
          for (const line of readFileSync(profileFile, "utf8")
            .split("\n")
            .filter(Boolean)) {
            try {
              const profile = JSON.parse(line);
              if (
                profile.schema !== "tracetoon.profile/v1" ||
                typeof profile.id !== "string" ||
                seen.has(profile.id) ||
                Date.parse(profile.at) < invocation.startedAt
              )
                continue;
              seen.add(profile.id);
              for (const [name, value] of Object.entries(
                profile.counters ?? {},
              ))
                if (
                  /^[a-z][a-zA-Z0-9.-]{0,80}$/.test(name) &&
                  typeof value === "number" &&
                  Number.isFinite(value) &&
                  value >= 0
                )
                  counts[name] = (counts[name] ?? 0) + value;
            } catch {
              gaps.push("An invalid runtime profile was excluded.");
            }
          }
        const reviewFile = join(root, "review.json"),
          resultFile = join(root, "review-result.json"),
          guidanceFile = join(root, "guidance.json"),
          packetFile = join(root, "review-input.json");
        if (
          existsSync(reviewFile) &&
          existsSync(guidanceFile) &&
          existsSync(packetFile) &&
          existsSync(resultFile)
        ) {
          const review = JSON.parse(readFileSync(reviewFile, "utf8")),
            guidance = JSON.parse(readFileSync(guidanceFile, "utf8"));
          const roles = [guidance.researcher, review.drafter, review.reviewer],
            ids = roles
              .filter(
                (role) =>
                  role?.mode === "delegated" &&
                  typeof role.agentId === "string" &&
                  role.agentId.trim(),
              )
              .map((role) => role.agentId);
          const current = currentTracetoonReview(root, headSha);
          workflow = {
            declaredIndependentRoles: new Set(ids).size,
            reviewCurrent: current,
            reviewVersion: review.v,
            limitations: [
              "Role IDs are host-reported; source snapshots and reviews do not independently attest model invocation or semantic correctness.",
            ],
          };
        }
        const file = join(root, "timings.json");
        if (!existsSync(file)) {
          gaps.push("A registered run has no internal timing log.");
          continue;
        }
        const timings = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(timings)) throw new Error("Malformed timing log");
        for (const timing of timings) {
          if (
            !timing ||
            typeof timing.stage !== "string" ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(timing.stage) ||
            typeof timing.durationMs !== "number" ||
            !Number.isFinite(timing.durationMs) ||
            timing.durationMs < 0
          ) {
            gaps.push("An invalid runtime timing was excluded.");
            continue;
          }
          entries.push({ stage: timing.stage, durationMs: timing.durationMs });
        }
      } catch {
        gaps.push("An internal timing log or its ownership could not be read.");
      }
    }
  if (!entries.length)
    gaps.push("No invocation-owned runtime stage timings were available.");
  return { entries, gaps: [...new Set(gaps)], counts, workflow };
}

export function tracetoonSystem(options: Partial<AgentOptions> = {}): System {
  const o = { ...DEFAULT_AGENT_OPTIONS, ...options };
  return {
    id: "tracetoon",
    description:
      "Claude Code with Tracetoon installed, asked to open a PR (comics off; stops at the preview).",
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
      if (run.isError)
        notes.push(`agent reported an error: ${describeRun(run)}`);
      const published = sandbox.capturedPRs().at(-1);
      const draft = tracetoonDraft(sandbox.gitDir);
      let title: string;
      let body: string;
      if (published?.title) {
        title = published.title;
        body = published.body ?? "";
        notes.push("PR was opened through gh");
      } else if (draft) {
        title = draft.title;
        body = draft.body;
        if (!draft.rendered)
          notes.push("Tracetoon did not render; body.md used");
        notes.push(`tracetoon run ${draft.run}`);
      } else {
        throw new Error(`tracetoon produced no PR draft (${describeRun(run)})`);
      }
      const artifact = agentArtifact({
        loaded,
        sandbox,
        system: "tracetoon",
        tool: "tracetoon",
        toolVersion: tt.version,
        model: o.model,
        title,
        body,
        run,
        startedAt: started,
        notes,
      });
      const timing = tracetoonTimings(sandbox.gitDir, {
        root: sandbox.repo,
        branch: sandbox.branch,
        startedAt: started,
      });
      artifact.meta.toolTimings = timing.entries;
      artifact.meta.toolTimingGaps = timing.gaps;
      artifact.meta.operationCounts = timing.counts;
      artifact.meta.workflow = timing.workflow;
      return artifact;
    },
  };
}
