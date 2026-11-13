/**
 * Token usage of one Codex invocation across every thread it ran.
 *
 * `codex exec --json` reports usage for the main thread only. When a skill
 * spawns subagents (researcher, drafter, reviewer…), Codex writes each one to
 * its own forked rollout file, and their usage never reaches stdout. The
 * rollouts record every model response as a `token_usage_record` (with its
 * thread and response id) and as a `token_count` event (running thread total
 * plus the last response). A fork may replay its parent's history, so records
 * are counted once per response id and attributed to the thread named in the
 * record, not to the file that holds it.
 *
 * Threads can run on different models (a skill may spawn a reviewer with
 * `spawn_agent { model: ... }`), so each response is attributed to the model
 * of its turn: the `turn_context` event with the record's `turn_id`, else the
 * thread's `thread_settings_applied` model, else the latest `turn_context` in
 * the same file. Usage is also reported per model so it can be priced per model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodexThreadUsage {
  threadId: string;
  /** `/root/researcher` and the like for subagents; undefined for the main thread. */
  agentPath?: string;
  subagent: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Model responses counted for this thread. */
  responses: number;
  /** Models this thread's responses ran on, where the rollout records them. */
  models: string[];
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Usage per model. Tokens from responses whose model is unknown are not in any entry. */
export type UsageByModel = Record<string, TokenUsage>;

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  threads: CodexThreadUsage[];
  subagentThreads: number;
  usageByModel: UsageByModel;
}

interface Totals {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
}
const count = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;

/** Usage summed over all threads in a set of rollout texts (JSONL). Undefined when no usage is recorded. */
export function codexUsageFromRollouts(texts: string[]): CodexUsage | undefined {
  const threads = new Map<string, CodexThreadUsage>();
  const thread = (id: string) => {
    let t = threads.get(id);
    if (!t) {
      t = {
        threadId: id,
        subagent: false,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        responses: 0,
        models: [],
      };
      threads.set(id, t);
    }
    return t;
  };
  const byModel: UsageByModel = {};
  const add = (t: CodexThreadUsage, u: Totals, model: string | undefined) => {
    const input = count(u.input_tokens),
      cached = Math.min(count(u.cached_input_tokens), input),
      output = count(u.output_tokens);
    t.inputTokens += input;
    t.cachedInputTokens += cached;
    t.outputTokens += output;
    t.responses++;
    if (!model) return;
    if (!t.models.includes(model)) t.models.push(model);
    const m = (byModel[model] ??= { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    m.inputTokens += input;
    m.cachedInputTokens += cached;
    m.outputTokens += output;
  };
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  // Model attribution, gathered from every file before any usage is counted.
  const turnModel = new Map<string, string>();
  const threadModel = new Map<string, string>();
  const pending: { id: string; turnId?: string; model?: string; fileModel?: string; usage: Totals }[] = [];
  const seen = new Set<string>();
  // Per file: its own thread, its model, and its last running total after any replayed history.
  const fallbacks: { id: string; total?: Totals; model?: string }[] = [];
  for (const text of texts) {
    let own: string | undefined, historyStart: number | undefined;
    let total: Totals | undefined;
    let fileModel: string | undefined, ownModel: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const p = e?.payload;
      if (!p || typeof p !== "object") continue;
      const replayed =
        historyStart !== undefined &&
        typeof e.ordinal === "number" &&
        e.ordinal < historyStart;
      if (e.type === "session_meta") {
        // The first session_meta is the file's own thread; later ones are replayed parents.
        if (own === undefined && typeof p.id === "string") {
          own = p.id;
          const t = thread(p.id);
          t.agentPath =
            typeof p.agent_path === "string" ? p.agent_path : undefined;
          t.subagent =
            p.thread_source === "subagent" ||
            typeof p.agent_path === "string" ||
            typeof p.parent_thread_id === "string" ||
            typeof p.forked_from_id === "string";
          if (typeof p.subagent_history_start_ordinal === "number")
            historyStart = p.subagent_history_start_ordinal;
          const m = str(p.model);
          if (m) threadModel.set(p.id, m);
        }
        continue;
      }
      if (e.type === "turn_context") {
        const m = str(p.model) ?? str(p.collaboration_mode?.settings?.model);
        if (!m) continue;
        fileModel = m;
        if (!replayed) ownModel = m;
        const turn = str(p.turn_id);
        if (turn) turnModel.set(turn, m);
        continue;
      }
      if (p.type === "thread_settings_applied") {
        const m = str(p.thread_settings?.model);
        const id = str(p.thread_id) ?? own;
        if (m && id) threadModel.set(id, m);
        continue;
      }
      if (e.type === "token_usage_record" && p.usage) {
        const id = typeof p.thread_id === "string" ? p.thread_id : own;
        if (!id) continue;
        const key =
          typeof p.response_id === "string"
            ? `r:${p.response_id}`
            : `t:${id}|${p.turn_id}|${e.timestamp}|${e.ordinal}`;
        if (seen.has(key)) continue;
        seen.add(key);
        thread(id);
        pending.push({ id, turnId: str(p.turn_id), model: str(p.model), fileModel, usage: p.usage });
        continue;
      }
      if (p.type === "token_count" && p.info?.total_token_usage && !replayed)
        total = p.info.total_token_usage;
    }
    if (own) fallbacks.push({ id: own, total, model: ownModel });
  }
  for (const r of pending)
    add(
      thread(r.id),
      r.usage,
      r.model ??
        (r.turnId ? turnModel.get(r.turnId) : undefined) ??
        threadModel.get(r.id) ??
        r.fileModel,
    );
  // Rollouts without per-response records: use the thread's own final running total.
  for (const { id, total, model } of fallbacks) {
    const t = thread(id);
    if (t.responses || !total) continue;
    add(t, total, threadModel.get(id) ?? model);
  }
  const list = [...threads.values()].filter((t) => t.responses > 0);
  if (!list.length) return undefined;
  const sum = (k: "inputTokens" | "cachedInputTokens" | "outputTokens") =>
    list.reduce((s, t) => s + t[k], 0);
  return {
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"),
    threads: list.sort(
      (a, b) =>
        Number(a.subagent) - Number(b.subagent) ||
        a.threadId.localeCompare(b.threadId),
    ),
    subagentThreads: list.filter((t) => t.subagent).length,
    usageByModel: byModel,
  };
}

/** Usage from every `*.jsonl` rollout in a folder (a retained `<system>.traces/` folder or a sessions tree). */
export function codexUsageFromDir(
  dir: string,
  include: (file: string) => boolean = () => true,
): CodexUsage | undefined {
  if (!existsSync(dir)) return undefined;
  const texts: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && include(p))
        texts.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return codexUsageFromRollouts(texts);
}

/** Rollout files already present, so a run counts only the sessions it created. */
export function codexRolloutSnapshot(codexHome: string): Set<string> {
  const found = new Set<string>();
  const dir = join(codexHome, "sessions");
  if (!existsSync(dir)) return found;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.add(p);
    }
  };
  walk(dir);
  return found;
}
