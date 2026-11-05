import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeAuthEnv,
  claudeAuthStatus,
  claudeProcessEnv,
  claudeTerminalEvent,
  runClaude,
  saveClaudeToken,
} from "../src/agents/claude.ts";
import { parseJudge } from "../src/judge/providers.ts";
import {
  inspectClaudeCatalogue,
  normalizeClaudeReport,
  verifyComparisonIsolation,
} from "../src/run/isolation.ts";
import { runCase } from "../src/run/runner.ts";
import { createSandbox } from "../src/run/sandbox.ts";
import { loadCase } from "../src/schema/case.ts";
import { PR_PROMPT } from "../src/systems/agentShared.ts";
import {
  CLAUDE_COMPARISON_TOOLS,
  claudeComparisonSystem,
} from "../src/systems/claudeComparison.ts";
import { cleanupTemps, EXAMPLE, tempDir } from "./helpers.ts";

afterAll(cleanupTemps);

const fixtures = join(import.meta.dir, "fixtures");
const TOKEN = "sk-ant-oat-test-secret-token";
const saved: Record<string, string | undefined> = {};
const setEnv = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
let log: string;
let pinned: { skill: string; runtime: string };
let hostSkill: string;

beforeAll(() => {
  log = join(tempDir(), "claude-calls.jsonl");
  const skill = tempDir("prbench-pinned-skill-");
  mkdirSync(join(skill, "bin"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Pinned synthetic skill\n");
  writeFileSync(join(skill, "VERSION"), "0.0.0-test");
  const runtime = join(
    tempDir(),
    `tracetoon${process.platform === "win32" ? ".exe" : ""}`,
  );
  const compiled = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(fixtures, "fake-comparison-runtime.ts"),
      "--outfile",
      runtime,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(compiled.exitCode).toBe(0);
  pinned = { skill, runtime };
  hostSkill = tempDir("prbench-host-skill-");
  writeFileSync(join(hostSkill, "SKILL.md"), "# Host skill: must not leak\n");
  setEnv({
    PRBENCH_CLAUDE_COMMAND: JSON.stringify([
      process.execPath,
      join(fixtures, "fake-claude.ts"),
    ]),
    PRBENCH_TRACETOON_SKILL: hostSkill,
    PRBENCH_TRACETOON_COMMAND: undefined,
    PRBENCH_CLAUDE_OAUTH_TOKEN: TOKEN,
    FAKE_CLAUDE_LOG: log,
    // A parent Claude Code session and its settings must not reach runs.
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ANTHROPIC_BASE_URL: "https://parent.invalid",
  });
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const calls = () =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const after = (args: string[], flag: string): string =>
  args[args.indexOf(flag) + 1]!;
const leaked = (call: any) =>
  call.inheritedClaudeEnv.filter(
    (k: string) => k !== "CLAUDE_CODE_OAUTH_TOKEN",
  );

describe("claude comparison writers", () => {
  const loaded = loadCase(EXAMPLE);
  const options = {
    model: "claude-sonnet-5-5",
    effort: "high",
    timeoutMs: 120_000,
  };

  test("native arm: isolated settings, effort, PR from gh, and stage timings", async () => {
    setEnv({ FAKE_CLAUDE_MODE: "comparison" });
    const { artifact } = await runCase(
      loaded,
      claudeComparisonSystem(false, options),
      { sandboxParent: tempDir() },
    );
    const call = calls().at(-1);
    expect(call.prompt).toBe(PR_PROMPT);
    expect(call.token).toBe(TOKEN);
    expect(leaked(call)).toEqual([]);
    expect(call.args).not.toContain(TOKEN);
    expect(call.tracetoonOff).toBe("0");
    expect(call.home).toContain("prbench-example-greet-default-");
    expect(after(call.args, "--model")).toBe("claude-sonnet-5-5");
    expect(after(call.args, "--effort")).toBe("high");
    expect(after(call.args, "--setting-sources")).toBe("user");
    expect(call.args).toContain("--strict-mcp-config");
    expect(JSON.parse(after(call.args, "--mcp-config"))).toEqual({
      mcpServers: {},
    });
    expect(call.args).not.toContain("--no-session-persistence");
    expect(after(call.args, "--allowedTools")).toBe(
      CLAUDE_COMPARISON_TOOLS.join(","),
    );
    expect(after(call.args, "--disallowedTools").split(",")).toEqual(
      expect.arrayContaining(["PowerShell", "WebFetch", "WebSearch"]),
    );
    expect(artifact.system).toBe("claude-native");
    expect(artifact.title).toBe("Claude fallback");
    expect(artifact.meta).toMatchObject({
      tool: "claude-code-native",
      toolVersion: "9.9.9",
      agent: "claude-code",
      model: "claude-sonnet-5-5",
      reasoningEffort: "high",
      inputTokens: 150,
      cachedInputTokens: 50,
    });
    expect(Object.keys(artifact.meta.stageTimings ?? {})).toEqual(
      expect.arrayContaining([
        "writerMs",
        "authWaitMs",
        "collectionEvidenceMs",
        "installationMs",
        "collectionMs",
      ]),
    );
    expect(artifact.meta.stageTimings?.authWaitMs).toBe(0);
    expect(
      artifact.validation?.commands.filter((c) => c.command === "bun test"),
    ).toHaveLength(1);
  });

  test("tracetoon arm installs only the pinned skill and runtime", async () => {
    setEnv({ FAKE_CLAUDE_MODE: "comparison" });
    const { artifact, sandboxRoot } = await runCase(
      loaded,
      claudeComparisonSystem(true, options, {
        id: "tracetoon-candidate",
        ...pinned,
      }),
      { sandboxParent: tempDir(), keepSandbox: true },
    );
    const call = calls().at(-1);
    const skill = join(sandboxRoot!, "home", ".claude", "skills", "tracetoon");
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(
      "# Pinned synthetic skill\n",
    );
    expect(readFileSync(join(sandboxRoot!, "bin", "tracetoon"))).toEqual(
      readFileSync(pinned.runtime),
    );
    expect(
      readFileSync(
        join(sandboxRoot!, "home", ".claude", "settings.json"),
        "utf8",
      ),
    ).toContain(join(sandboxRoot!, "bin", "tracetoon"));
    expect(call.tracetoonOff).toBeUndefined();
    expect(JSON.parse(readFileSync(call.tracetoonConfig, "utf8"))).toEqual({
      comic: "off",
    });
    expect(
      call.args.filter(
        (_: string, i: number) => call.args[i - 1] === "--add-dir",
      ),
    ).toEqual([join(sandboxRoot!, "git"), skill]);
    expect(artifact.system).toBe("tracetoon-candidate");
    expect(artifact.meta).toMatchObject({
      tool: "tracetoon",
      toolVersion: "0.0.0-test",
      agent: "claude-code",
      reasoningEffort: "high",
    });
    expect(artifact.meta.toolTimings).toEqual([
      { stage: "digest", durationMs: 7 },
      { stage: "context", durationMs: 3 },
    ]);
  });

  test("a tracetoon arm with no PR and no invocation-owned draft fails clearly", async () => {
    setEnv({ FAKE_CLAUDE_MODE: "nothing" });
    await expect(
      runCase(
        loaded,
        claudeComparisonSystem(true, options, {
          id: "tracetoon-baseline",
          ...pinned,
        }),
        { sandboxParent: tempDir() },
      ),
    ).rejects.toThrow(/tracetoon-baseline produced no PR draft/);
  });

  test("an unknown effort is rejected before any run", () => {
    expect(() =>
      claudeComparisonSystem(false, { ...options, effort: "ultra" }),
    ).toThrow(/Unknown Claude effort/);
  });

  test("the result event stops lingering CLI cleanup", async () => {
    setEnv({ FAKE_CLAUDE_MODE: "linger" });
    expect(claudeTerminalEvent('{"type":"result","is_error":true}')).toBe(
      "failure",
    );
    expect(claudeTerminalEvent("not json")).toBeUndefined();
    const sandbox = createSandbox(loaded, { parent: tempDir() });
    try {
      const began = Date.now();
      const run = await runClaude(sandbox, {
        prompt: "linger",
        model: "claude-sonnet-5-5",
        allowedTools: [],
        timeoutMs: 30_000,
      });
      expect(Date.now() - began).toBeLessThan(20_000);
      expect(run.cleanupTerminated).toBe(true);
      expect(run.exitCode).toBe(0);
      expect(run.isError).toBe(false);
    } finally {
      sandbox.dispose();
    }
  });
});

describe("claude isolation probe", () => {
  const variants = () => [
    { system: "claude-native" },
    { system: "tracetoon-baseline", pinned },
    { system: "tracetoon-candidate", pinned },
  ];
  const probe = (root: string, concurrency?: number) =>
    verifyComparisonIsolation({
      root,
      experiment: "exp-claude",
      probeCase: EXAMPLE,
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      variants: variants(),
      agent: "claude",
      effort: "medium",
      concurrency,
    });

  test("passes concurrently and saves probes in model x variant order", async () => {
    setEnv({
      FAKE_CLAUDE_DELAY_MS: "400",
      FAKE_CLAUDE_EXTRA_SKILL: undefined,
      FAKE_CLAUDE_PROBE_TOOL: undefined,
      FAKE_CLAUDE_PROBE_REPLY: undefined,
      FAKE_CLAUDE_MCP: undefined,
    });
    const root = tempDir();
    const before = calls().length;
    try {
      await probe(root, 3);
    } finally {
      setEnv({ FAKE_CLAUDE_DELAY_MS: undefined });
    }
    const saved = JSON.parse(
      readFileSync(join(root, "isolation.json"), "utf8"),
    );
    expect(saved.probes.map((p: any) => `${p.model}/${p.system}`)).toEqual([
      "claude-opus-5-5/claude-native",
      "claude-opus-5-5/tracetoon-baseline",
      "claude-opus-5-5/tracetoon-candidate",
      "claude-sonnet-5-5/claude-native",
      "claude-sonnet-5-5/tracetoon-baseline",
      "claude-sonnet-5-5/tracetoon-candidate",
    ]);
    expect(
      saved.probes.every(
        (p: any) =>
          p.passed &&
          p.catalogue.toolCalls === 0 &&
          p.catalogue.catalogues === 1,
      ),
    ).toBe(true);
    expect(saved.probes[0].catalogue.paths).toEqual([]);
    expect(saved.probes[1].catalogue.paths).toHaveLength(1);
    const probeCalls = calls()
      .slice(before)
      .filter((c) => c.prompt.startsWith("Without running any tools"));
    expect(probeCalls).toHaveLength(6);
    for (const c of probeCalls) {
      expect(after(c.args, "--tools")).toBe("Skill");
      expect(after(c.args, "--permission-mode")).toBe("dontAsk");
      expect(after(c.args, "--effort")).toBe("medium");
      expect(leaked(c)).toEqual([]);
    }
    // Sweep start/end marks for the largest number running at once.
    let peak = 0,
      running = 0;
    for (const [, delta] of probeCalls
      .flatMap((c) => [
        [c.start, 1],
        [c.end, -1],
      ])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!))
      peak = Math.max(peak, (running += delta!));
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(3);
    // A saved proof is reused without calling the model again.
    const count = calls().length;
    await probe(root, 3);
    expect(calls().length).toBe(count);
  });

  for (const [name, vars, message] of [
    [
      "a leaked plugin copy",
      { FAKE_CLAUDE_EXTRA_SKILL: "host-plugin:tracetoon" },
      /isolation failed/,
    ],
    ["a tool call", { FAKE_CLAUDE_PROBE_TOOL: "1" }, /no tool calls/],
    [
      "a wrong self-report",
      { FAKE_CLAUDE_PROBE_REPLY: "/host/.claude/skills/tracetoon/SKILL.md" },
      /isolation failed/,
    ],
    ["an MCP server", { FAKE_CLAUDE_MCP: "host-server" }, /MCP servers/],
  ] as const)
    test(`fails on ${name}`, async () => {
      const root = tempDir();
      setEnv(vars);
      try {
        await expect(probe(root)).rejects.toThrow(message);
      } finally {
        setEnv(
          Object.fromEntries(Object.keys(vars).map((k) => [k, undefined])),
        );
      }
      expect(existsSync(join(root, "isolation.json"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(root, "isolation-failure.json"), "utf8")),
      ).toMatchObject({ experiment: "exp-claude" });
    });

  test("catalogue inspection resolves names to on-disk copies", () => {
    const home = tempDir(),
      repo = tempDir();
    const user = join(home, ".claude", "skills", "tracetoon");
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, "SKILL.md"), "x");
    const init = { type: "system", subtype: "init", skills: ["tracetoon"] };
    expect(inspectClaudeCatalogue(init, 0, { home, repo }).paths).toEqual([
      join(user, "SKILL.md"),
    ]);
    const project = join(repo, ".claude", "skills", "tracetoon");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "SKILL.md"), "x");
    expect(inspectClaudeCatalogue(init, 0, { home, repo }).paths).toHaveLength(
      2,
    );
    expect(
      inspectClaudeCatalogue(undefined, 0, { home, repo }).catalogues,
    ).toBe(0);
    expect(
      normalizeClaudeReport("`~/.claude/skills/tracetoon/SKILL.md`", home),
    ).toBe(join(user, "SKILL.md"));
    expect(normalizeClaudeReport("tracetoon", home, "/x/SKILL.md")).toBe(
      "/x/SKILL.md",
    );
    expect(normalizeClaudeReport("tracetoon", home)).toBe("tracetoon");
  });
});

describe("claude judge", () => {
  const side = { notes: "synthetic" };
  test("claude:model@effort runs isolated with a temp HOME and no tools", async () => {
    setEnv({ FAKE_CLAUDE_JUDGMENT: JSON.stringify({ A: side, B: side }) });
    const judge = parseJudge("claude:claude-opus-5-5@high");
    expect(judge.id).toBe("claude:claude-opus-5-5@high");
    expect(judge.family).toBe("anthropic");
    const reply = await judge.ask("Synthetic judge prompt");
    expect(JSON.parse(reply.text)).toEqual({ A: side, B: side });
    const call = calls().at(-1);
    expect(call.prompt).toBe("Synthetic judge prompt");
    expect(call.home).not.toBe(homedir());
    expect(call.home).toContain("prbench-judge-");
    expect(existsSync(call.home)).toBe(false); // temp dirs are removed
    expect(call.token).toBe(TOKEN);
    expect(call.args).not.toContain(TOKEN);
    expect(JSON.stringify(call.args)).not.toContain(TOKEN);
    expect(leaked(call)).toEqual([]);
    expect(after(call.args, "--tools")).toBe("");
    expect(after(call.args, "--setting-sources")).toBe("");
    expect(after(call.args, "--effort")).toBe("high");
    expect(after(call.args, "--model")).toBe("claude-opus-5-5");
    expect(call.args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--json-schema",
      ]),
    );
    expect(JSON.parse(after(call.args, "--settings"))).toEqual({
      disableAllHooks: true,
    });
  });

  test("legacy ids are unchanged and bad efforts are rejected", () => {
    expect(parseJudge("claude").id).toBe("claude:opus");
    expect(parseJudge("claude:sonnet").id).toBe("claude:sonnet");
    expect(() => parseJudge("claude:opus@ultra")).toThrow(
      /Unknown Claude effort/,
    );
    expect(() => parseJudge("claude@high")).toThrow(/invalid judge/);
  });
});

describe("claude auth and environment", () => {
  test("sandboxes drop parent Anthropic and Claude Code variables", () => {
    setEnv({ ANTHROPIC_API_KEY: "parent-key" });
    const sandbox = createSandbox(loadCase(EXAMPLE), { parent: tempDir() });
    try {
      const keys = Object.keys(sandbox.env);
      expect(
        keys.filter(
          (k) =>
            /^(ANTHROPIC_|CLAUDE_CODE_)/i.test(k) ||
            ["CLAUDECODE", "PRBENCH_CLAUDE_OAUTH_TOKEN"].includes(k),
        ),
      ).toEqual([]);
      expect(Object.values(sandbox.env)).not.toContain(TOKEN);
    } finally {
      sandbox.dispose();
      setEnv({ ANTHROPIC_API_KEY: saved.ANTHROPIC_API_KEY });
    }
    expect(
      claudeProcessEnv(
        {
          PATH: "/bin",
          ANTHROPIC_MODEL: "x",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDECODE: "1",
          CLAUDE_CONFIG_DIR: "/host",
        },
        { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      ),
    ).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  });

  test("status names the source, never the token, and saved tokens are owner-only", () => {
    const file = join(tempDir(), "nested", "claude-oauth-token");
    const env = { PRBENCH_CLAUDE_TOKEN_FILE: file };
    expect(claudeAuthStatus(env)).toEqual({ ok: false, source: "none" });
    expect(() => saveClaudeToken("  \n", env)).toThrow(/empty/);
    expect(saveClaudeToken(`  ${TOKEN}\n`, env)).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(`${TOKEN}\n`);
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(claudeAuthStatus(env)).toEqual({ ok: true, source: file });
    expect(claudeAuthEnv(env)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(
      claudeAuthStatus({ ...env, PRBENCH_CLAUDE_OAUTH_TOKEN: "x" }),
    ).toEqual({ ok: true, source: "PRBENCH_CLAUDE_OAUTH_TOKEN" });
    expect(claudeAuthStatus({ CLAUDE_CODE_OAUTH_TOKEN: "x" })).toEqual({
      ok: true,
      source: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(
      claudeAuthStatus({
        ANTHROPIC_API_KEY: "k",
        PRBENCH_CLAUDE_TOKEN_FILE: file,
      }),
    ).toEqual({ ok: true, source: "ANTHROPIC_API_KEY" });
    expect(JSON.stringify(claudeAuthStatus(env))).not.toContain(TOKEN);
  });
});
