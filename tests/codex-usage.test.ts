import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withThreadUsage } from "../src/agents/codex.ts";
import { codexUsageFromDir, codexUsageFromRollouts } from "../src/agents/codexUsage.ts";
import { checkArtifact } from "../src/schema/artifact.ts";
import { collectDraftScores, estimateCostByModel, scoreMarkdown, writerTraceUsage } from "../src/report/score.ts";
import { claudeUsageByModel } from "../src/agents/claude.ts";
import type { SideJudgment } from "../src/judge/rubric.ts";
import { cleanupTemps, tempDir } from "./helpers.ts";

afterAll(cleanupTemps);

const MAIN = "01a1-main";
const SUB = "01a1-sub";
const usage = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const record = (thread: string, response: string, u: ReturnType<typeof usage>, ordinal: number) => ({
  timestamp: "2026-11-08T00:00:00.000Z",
  ordinal,
  type: "token_usage_record",
  payload: { thread_id: thread, turn_id: "t", session_id: MAIN, response_id: response, usage: u },
});
const tokenCount = (total: ReturnType<typeof usage>, last: ReturnType<typeof usage>, ordinal: number) => ({
  ordinal,
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
});
const mainMeta = { type: "session_meta", payload: { id: MAIN, session_id: MAIN, source: "exec", thread_source: "user" } };

/** Main thread with two responses; a forked researcher that replays the parent's first record, then makes two of its own. */
function rollouts() {
  const main = jsonl([
    mainMeta,
    record(MAIN, "r1", usage(1000, 800, 10), 1),
    tokenCount(usage(1000, 800, 10), usage(1000, 800, 10), 2),
    record(MAIN, "r2", usage(2000, 1500, 20), 3),
    tokenCount(usage(3000, 2300, 30), usage(2000, 1500, 20), 4),
  ]);
  const fork = jsonl([
    {
      type: "session_meta",
      payload: {
        id: SUB,
        session_id: MAIN,
        forked_from_id: MAIN,
        parent_thread_id: MAIN,
        thread_source: "subagent",
        agent_path: "/root/researcher",
        subagent_history_start_ordinal: 5,
      },
    },
    // Replayed parent history: its session_meta, a usage record and a running total.
    mainMeta,
    record(MAIN, "r1", usage(1000, 800, 10), 1),
    tokenCount(usage(1000, 800, 10), usage(1000, 800, 10), 2),
    record(SUB, "s1", usage(5000, 4000, 50), 6),
    tokenCount(usage(5000, 4000, 50), usage(5000, 4000, 50), 7),
    record(SUB, "s2", usage(6000, 5000, 60), 8),
    tokenCount(usage(11000, 9000, 110), usage(6000, 5000, 60), 9),
  ]);
  return { main, fork };
}

test("Codex usage sums the main thread and forked subagents, counting replayed history once", () => {
  const { main, fork } = rollouts();
  const u = codexUsageFromRollouts([main, fork])!;
  expect(u.inputTokens).toBe(3000 + 11000);
  expect(u.cachedInputTokens).toBe(2300 + 9000);
  expect(u.outputTokens).toBe(30 + 110);
  expect(u.subagentThreads).toBe(1);
  expect(u.threads.map((t) => [t.threadId, t.agentPath, t.subagent, t.inputTokens, t.responses])).toEqual([
    [MAIN, undefined, false, 3000, 2],
    [SUB, "/root/researcher", true, 11000, 2],
  ]);
  // File order does not matter.
  expect(codexUsageFromRollouts([fork, main])!.inputTokens).toBe(14000);
  // Without per-response records, each file's own final running total is used, skipping replayed history.
  const strip = (t: string) =>
    t
      .split("\n")
      .filter((l) => !l.includes("token_usage_record"))
      .join("\n");
  const fallback = codexUsageFromRollouts([strip(main), strip(fork)])!;
  expect(fallback.inputTokens).toBe(14000);
  expect(fallback.outputTokens).toBe(140);
  expect(codexUsageFromRollouts(["not json\n", jsonl([mainMeta])])).toBeUndefined();
});

test("live Codex runs report all-thread usage and say so", () => {
  const { main, fork } = rollouts();
  const parsed = { inputTokens: 3000, cachedInputTokens: 2300, outputTokens: 30, numTurns: 1 };
  const all = withThreadUsage(parsed, codexUsageFromRollouts([main, fork]));
  expect(all).toMatchObject({ inputTokens: 14000, cachedInputTokens: 11300, outputTokens: 140, usageScope: "all-threads", subagentThreads: 1 });
  expect(withThreadUsage(parsed, undefined)).toMatchObject({ inputTokens: 3000, usageScope: "main-thread" });
  // Rollouts that cover less than stdout reported are not trusted.
  expect(withThreadUsage({ ...parsed, inputTokens: 99999 }, codexUsageFromRollouts([main]))).toMatchObject({
    inputTokens: 99999,
    usageScope: "main-thread",
  });
  const meta = { tool: "t", startedAt: new Date().toISOString(), durationMs: 1, inputTokens: 1, usageScope: "all-threads", subagentThreads: 2 };
  const artifact = { schema: "prbench.artifact/v1", case: "c", system: "s", title: "t", body: "", base: "b", commits: [], diff: "", meta };
  expect(checkArtifact(artifact)).toEqual([]);
  expect(checkArtifact({ ...artifact, meta: { ...meta, usageScope: "some" } }).length).toBe(1);
});

const side = (): SideJudgment => ({
  factualErrors: [],
  unsupportedClaims: [],
  claimAssessments: [],
  claimsCovered: ["C1"],
  contextCovered: [],
  uncertaintiesRespected: [],
  trapsHit: [],
  rubric: {},
  notes: "",
} as unknown as SideJudgment);

test("score recomputes Codex cost from the accepted attempt's saved traces", () => {
  const root = tempDir();
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof v === "string" ? v : JSON.stringify(v));
  };
  const facts = { claims: ["c1"], context: [], uncertainties: [] };
  write("luna/tracetoon-baseline/judgments/v6/one/j/ab.json", {
    rubricVersion: "6",
    judge: "codex:j@medium",
    case: "one",
    order: "ab",
    labels: { A: "tracetoon-baseline", B: "tracetoon-candidate" },
    judgment: { A: side(), B: side(), preferred: "tie" },
  });
  const key = "ab".repeat(32);
  // Main-thread-only meta, as saved before subagent usage was counted.
  const meta = { agent: "codex", model: "gpt-6-luna", inputTokens: 3000, cachedInputTokens: 2300, outputTokens: 30 };
  write("luna/artifacts/one/tracetoon-baseline.json", { meta });
  write("luna/artifacts/one/tracetoon-baseline.receipt.json", { experiment: "e", key, digest: "d" });
  const { main, fork } = rollouts();
  // A failed earlier attempt with traces is ignored; the accepted one is used.
  write(`attempts/writer/${key}/001/failure.json`, { failureKind: "no-draft" });
  write(`attempts/writer/${key}/001/one/tracetoon-baseline.traces/x.jsonl`, jsonl([mainMeta, record(MAIN, "z", usage(9e6, 0, 0), 1)]));
  write(`attempts/writer/${key}/002/one/tracetoon-baseline.traces/a.jsonl`, main);
  write(`attempts/writer/${key}/002/one/tracetoon-baseline.traces/b.jsonl`, fork);
  // The candidate has no traces: its cost stays main-thread only and is labelled so.
  write("luna/artifacts/one/tracetoon-candidate.json", { meta });
  expect(writerTraceUsage(root, join(root, "luna/artifacts/one/tracetoon-baseline.json"))!.inputTokens).toBe(14000);
  expect(codexUsageFromDir(join(root, `attempts/writer/${key}/002/one/tracetoon-baseline.traces`))!.subagentThreads).toBe(1);
  const drafts = collectDraftScores(root, () => facts);
  const base = drafts.find((d) => d.system === "tracetoon-baseline")!;
  const cand = drafts.find((d) => d.system === "tracetoon-candidate")!;
  expect(base).toMatchObject({ inputTokens: 14000, cachedInputTokens: 11300, outputTokens: 140, usageScope: "all-threads", usageSource: "traces", subagentThreads: 1 });
  expect(cand).toMatchObject({ inputTokens: 3000, usageScope: "main-thread" });
  expect(cand.subagentThreads).toBeUndefined();
  // Luna list prices: $0.10 input, $0.01 cached, $0.50 output per million tokens.
  expect(base.costUsd).toBeCloseTo(((14000 - 11300) * 0.1 + 11300 * 0.01 + 140 * 0.5) / 1e6, 12);
  expect(cand.costUsd).toBeCloseTo((700 * 0.1 + 2300 * 0.01 + 30 * 0.5) / 1e6, 12);
  const md = scoreMarkdown(drafts);
  expect(md).toContain("| all threads (traces) | 1.0 |");
  expect(md).toContain("| main thread only | – |");
  expect(md).toContain("Cost covers:");
});

/**
 * A gpt-6-luna main thread that spawns a reviewer on gpt-6.1-terra. The fork
 * replays the parent's Luna turn_context and first record before its own
 * Terra turn; models come from turn_context (by turn id) and thread settings.
 */
function mixedRollouts() {
  const LUNA = "gpt-6-luna",
    TERRA = "gpt-6.1-terra";
  const ctx = (turn: string, model: string, ordinal: number) => ({
    ordinal,
    type: "turn_context",
    payload: { turn_id: turn, model, effort: "low", collaboration_mode: { mode: "default", settings: { model, reasoning_effort: "low" } } },
  });
  const rec = (thread: string, turn: string, response: string, u: ReturnType<typeof usage>, ordinal: number) => ({
    ordinal,
    type: "token_usage_record",
    payload: { thread_id: thread, turn_id: turn, session_id: MAIN, response_id: response, usage: u },
  });
  const main = jsonl([
    mainMeta,
    ctx("mt", LUNA, 1),
    rec(MAIN, "mt", "r1", usage(1000, 800, 10), 2),
    {
      ordinal: 3,
      type: "response_item",
      payload: { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ task_name: "reviewer", model: TERRA, reasoning_effort: "medium" }) },
    },
    rec(MAIN, "mt", "r2", usage(2000, 1500, 20), 4),
  ]);
  const fork = jsonl([
    {
      ordinal: 0,
      type: "session_meta",
      payload: { id: SUB, session_id: MAIN, forked_from_id: MAIN, parent_thread_id: MAIN, thread_source: "subagent", agent_path: "/root/reviewer", subagent_history_start_ordinal: 5 },
    },
    { ...mainMeta, ordinal: 1 },
    ctx("mt", LUNA, 2),
    rec(MAIN, "mt", "r1", usage(1000, 800, 10), 3),
    { ordinal: 5, type: "event_msg", payload: { type: "thread_settings_applied", thread_id: SUB, thread_settings: { model: TERRA, reasoning_effort: "medium" } } },
    ctx("st", TERRA, 6),
    rec(SUB, "st", "s1", usage(5000, 4000, 50), 7),
    rec(SUB, "st", "s2", usage(6000, 5000, 60), 8),
  ]);
  return { main, fork };
}

test("Codex usage is attributed per model when a subagent runs on another model", () => {
  const { main, fork } = mixedRollouts();
  const u = codexUsageFromRollouts([fork, main])!;
  expect(u.inputTokens).toBe(14000);
  expect(u.usageByModel).toEqual({
    "gpt-6-luna": { inputTokens: 3000, cachedInputTokens: 2300, outputTokens: 30 },
    "gpt-6.1-terra": { inputTokens: 11000, cachedInputTokens: 9000, outputTokens: 110 },
  });
  expect(u.threads.map((t) => [t.agentPath, t.models])).toEqual([
    [undefined, ["gpt-6-luna"]],
    ["/root/reviewer", ["gpt-6.1-terra"]],
  ]);
  // Without per-response records the fallback uses the thread's own model, not the replayed parent's.
  const strip = (t: string) => t.split("\n").filter((l) => !l.includes("token_usage_record")).join("\n");
  const withTotals = (t: string, total: ReturnType<typeof usage>) => strip(t) + JSON.stringify(tokenCount(total, total, 99)) + "\n";
  const fb = codexUsageFromRollouts([withTotals(main, usage(3000, 2300, 30)), withTotals(fork, usage(11000, 9000, 110))])!;
  expect(Object.keys(fb.usageByModel).sort()).toEqual(["gpt-6-luna", "gpt-6.1-terra"]);
  expect(fb.usageByModel["gpt-6.1-terra"]!.inputTokens).toBe(11000);
  // Live capture carries the split into the run result and the artifact schema accepts it.
  const live = withThreadUsage({ inputTokens: 3000, numTurns: 1 }, u);
  expect(live.usageByModel).toEqual(u.usageByModel);
  const meta = { tool: "t", startedAt: new Date().toISOString(), durationMs: 1, inputTokens: 14000, usageScope: "all-threads", usageByModel: u.usageByModel };
  const artifact = { schema: "prbench.artifact/v1", case: "c", system: "s", title: "t", body: "", base: "b", commits: [], diff: "", meta };
  expect(checkArtifact(artifact)).toEqual([]);
  expect(checkArtifact({ ...artifact, meta: { ...meta, usageByModel: { m: { inputTokens: -1 } } } }).length).toBeGreaterThan(0);
});

test("score prices a Luna writer's Terra reviewer at Terra rates, from traces and from the artifact", () => {
  const root = tempDir();
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof v === "string" ? v : JSON.stringify(v));
  };
  const facts = { claims: ["c1"], context: [], uncertainties: [] };
  write("luna/tracetoon-baseline/judgments/v6/one/j/ab.json", {
    rubricVersion: "6",
    judge: "codex:j@medium",
    case: "one",
    order: "ab",
    labels: { A: "tracetoon-baseline", B: "tracetoon-candidate" },
    judgment: { A: side(), B: side(), preferred: "tie" },
  });
  const key = "cd".repeat(32);
  const { main, fork } = mixedRollouts();
  // Baseline: main-thread-only meta, recomputed from traces.
  write("luna/artifacts/one/tracetoon-baseline.json", { meta: { agent: "codex", model: "gpt-6-luna", inputTokens: 3000, cachedInputTokens: 2300, outputTokens: 30 } });
  write("luna/artifacts/one/tracetoon-baseline.receipt.json", { experiment: "e", key, digest: "d" });
  write(`attempts/writer/${key}/001/one/tracetoon-baseline.traces/a.jsonl`, main);
  write(`attempts/writer/${key}/001/one/tracetoon-baseline.traces/b.jsonl`, fork);
  // Candidate: live all-thread capture with the split in meta.
  const u = codexUsageFromRollouts([main, fork])!;
  write("luna/artifacts/one/tracetoon-candidate.json", {
    meta: { agent: "codex", model: "gpt-6-luna", inputTokens: 14000, cachedInputTokens: 11300, outputTokens: 140, usageScope: "all-threads", subagentThreads: 1, usageByModel: u.usageByModel },
  });
  const luna = (700 * 0.1 + 2300 * 0.01 + 30 * 0.5) / 1e6;
  const terra = (2000 * 1 + 9000 * 0.05 + 110 * 5) / 1e6;
  const drafts = collectDraftScores(root, () => facts);
  for (const d of drafts) {
    expect(d.costUsd).toBeCloseTo(luna + terra, 12);
    expect(d.models).toEqual(["gpt-6-luna", "gpt-6.1-terra"]);
  }
  // All at Luna rates would understate it.
  expect(luna + terra).toBeGreaterThan(((14000 - 11300) * 0.1 + 11300 * 0.01 + 140 * 0.5) / 1e6);
  const md = scoreMarkdown(drafts);
  expect(md).toContain("Mixed-model writers");
  expect(md).toContain("| luna | tracetoon-candidate | 1/1 | gpt-6-luna, gpt-6.1-terra |");
});

test("per-model cost prices unattributed tokens at the arm's model and refuses unpriced models", () => {
  const table = { a: { input: 1, cachedInput: 0.1, output: 2 }, b: { input: 10, cachedInput: 1, output: 20 } };
  const t = { inputTokens: 3_000_000, cachedInputTokens: 0, outputTokens: 0 };
  expect(estimateCostByModel("a", t, undefined, table)).toBeCloseTo(3, 9);
  expect(estimateCostByModel("a", t, { b: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 } }, table)).toBeCloseTo(10 + 2, 9);
  expect(estimateCostByModel("a", t, { z: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 } }, table)).toBeUndefined();
});

test("Claude modelUsage gives per-model usage and USD that sum to the reported total", () => {
  const modelUsage = {
    "claude-sonnet-5-5": { inputTokens: 72, outputTokens: 16587, cacheReadInputTokens: 1401292, cacheCreationInputTokens: 91130, costUSD: 0.6179712 },
    "claude-haiku-5-5": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 13622, costUSD: 0.00170495 },
  };
  const { usageByModel } = claudeUsageByModel(modelUsage);
  expect(usageByModel!["claude-sonnet-5-5"]).toEqual({ inputTokens: 72 + 1401292 + 91130, cachedInputTokens: 1401292, outputTokens: 16587, costUsd: 0.6179712 });
  expect(Object.values(usageByModel!).reduce((s, u) => s + u.costUsd!, 0)).toBeCloseTo(0.61967615, 9);
  expect(claudeUsageByModel({})).toEqual({});
  expect(claudeUsageByModel(undefined)).toEqual({});
});
