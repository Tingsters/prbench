// Provider adapters describe executions; this module owns their neutral evidence.
// Never infer a check from the writer's final message or a tool's self-review.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { canonicalCheck, checkExecution } from "./validationCheck.ts";
import type { Sandbox } from "../run/sandbox.ts";
import {
  VALIDATION_SCHEMA,
  type CommandEvidence,
  type TreeObservation,
  type ValidationEvidence,
} from "../schema/validation.ts";
import {
  displaysCommand,
  staticExecutionContexts,
  type ExecutionContext,
} from "./orchestration.ts";

const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const OUTPUT_LIMIT = 24_000;
const TRACE_LIMIT = 32 * 1024 * 1024;

export function redactEvidence(
  text: string,
  paths: [string, string][] = [],
  secrets: string[] = [],
): string {
  let s = text;
  for (const [path, replacement] of [...paths].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    const spellings = new Set([path, path.replace(/\\/g, "/")]);
    for (let depth = 0; depth < 2; depth++)
      for (const value of [...spellings])
        spellings.add(JSON.stringify(value).slice(1, -1));
    for (const spelling of [...spellings].sort((a, b) => b.length - a.length))
      if (spelling) s = s.split(spelling).join(replacement);
  }
  for (const secret of secrets)
    if (secret.length >= 8) s = s.split(secret).join("[redacted]");
  return s
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[redacted]",
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
      "[redacted]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[=:]\s*["']?)[^\s"',;}]+/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, "<user>")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "<user>");
}

/** Hash tracked and non-ignored untracked bytes, including deletions and symlinks. */
export function observeTree(repo: string): TreeObservation | undefined {
  try {
    const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const files = Bun.spawnSync(
      [
        "git",
        "-C",
        repo,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (head.exitCode || files.exitCode) return;
    const names = [
      ...new Set(files.stdout.toString().split("\0").filter(Boolean)),
    ].sort();
    if (names.length > 20_000) return;
    const digest = createHash("sha256");
    let bytes = 0;
    for (const name of names) {
      const path = join(repo, name);
      digest.update(name).update("\0");
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        digest.update("deleted\0");
        continue;
      }
      if (stat.isDirectory()) {
        digest.update("directory\0");
        continue;
      } // submodule contents aren't covered
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024) return;
      digest.update(String(stat.mode & 0o111)).update("\0");
      digest
        .update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path))
        .update("\0");
    }
    return {
      head: head.stdout.toString().trim(),
      fingerprint: digest.digest("hex"),
      at: new Date().toISOString(),
    };
  } catch {
    return;
  } // Evidence capture failure is a visible gap, never a failed test.
}

function textOf(x: any): string {
  if (typeof x === "string") return x;
  if (Array.isArray(x))
    return x.map((p) => textOf(p?.text ?? p?.content ?? p)).join("\n");
  return x == null ? "" : JSON.stringify(x);
}

function commandOf(x: any): string {
  if (typeof x === "string") {
    try {
      return commandOf(JSON.parse(x));
    } catch {
      return x;
    }
  }
  if (Array.isArray(x)) return x.join(" ");
  return textOf(x?.cmd ?? x?.command ?? x?.input ?? x);
}

interface TraceEvent {
  id: string;
  phase: "start" | "finish";
  command?: string;
  cwd?: string;
  at?: string;
  output?: string;
  exitCode?: number;
  error?: boolean;
  interrupted?: boolean;
  aliasSession?: string;
}

function executionName(name: string): boolean {
  return /^(?:Bash|PowerShell|shell|exec|.*(?:exec_command|shell_command|local_shell_call|functions\.exec|functions\.wait|write_stdin))$/.test(
    name,
  );
}

function events(j: any): TraceEvent[] {
  const at = typeof j.timestamp === "string" ? j.timestamp : undefined;
  if (
    /^item\.(?:started|completed)$/.test(j.type) &&
    j.item?.type === "command_execution"
  ) {
    const p = j.item;
    return [
      {
        id: p.id,
        phase: j.type === "item.started" ? "start" : "finish",
        command: commandOf(p.command),
        cwd: p.cwd,
        at,
        output: p.aggregated_output,
        exitCode: p.exit_code,
        interrupted: p.status === "cancelled" || p.status === "interrupted",
      },
    ];
  }
  if (j.type === "response_item") {
    const p = j.payload ?? {};
    if (
      ["function_call", "custom_tool_call", "local_shell_call"].includes(
        p.type,
      ) &&
      executionName(p.name ?? p.type)
    ) {
      let input: any = p.arguments ?? p.input ?? p.action;
      try {
        if (typeof input === "string") input = JSON.parse(input);
      } catch {
        /* JS orchestration is retained as text. */
      }
      return [
        {
          id: p.call_id ?? p.id,
          phase: "start",
          command: commandOf(input),
          cwd: input?.workdir ?? input?.cwd,
          at,
          aliasSession:
            input?.session_id === undefined && input?.cell_id === undefined
              ? undefined
              : String(input.session_id ?? input.cell_id),
        },
      ];
    }
    if (["function_call_output", "custom_tool_call_output"].includes(p.type))
      return [{ id: p.call_id, phase: "finish", at, output: textOf(p.output) }];
  }
  const content = j.message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((p: any): TraceEvent[] => {
    if (!p || typeof p !== "object") return [];
    if (p.type === "tool_use" && executionName(p.name))
      return [
        {
          id: p.id,
          phase: "start",
          command: commandOf(p.input),
          cwd: p.input?.cwd,
          at,
        },
      ];
    if (p.type === "tool_result")
      return [
        {
          id: p.tool_use_id,
          phase: "finish",
          output: textOf(p.content),
          error: p.is_error,
          at,
        },
      ];
    return [];
  });
}

function outputFacts(raw: string): {
  text: string;
  code?: number;
  session?: string;
  interrupted: boolean;
  truncated: boolean;
  ambiguous: boolean;
} {
  let text = raw,
    code: number | undefined,
    session: string | undefined;
  try {
    const p = JSON.parse(raw);
    if (typeof p.output === "string") text = p.output;
    if (Number.isInteger(p.exit_code)) code = p.exit_code;
    if (p.session_id !== undefined || p.cell_id !== undefined)
      session = String(p.session_id ?? p.cell_id);
  } catch {
    /* Ordinary shell output. */
  }
  const matches = [
    ...raw.matchAll(
      /(?:Process exited with code|["']?exit[_ ]code["']?\s*[:=]?)\s*(-?\d+)/gi,
    ),
  ];
  if (code === undefined && matches.length === 1) code = Number(matches[0]![1]);
  const running = /Script running with cell ID\s+(\S+)/.exec(raw);
  if (running) session = running[1];
  return {
    text,
    code,
    session,
    ambiguous: matches.length > 1 && code === undefined,
    interrupted:
      /Command timed out|execution (?:was )?(?:cancelled|canceled|interrupted)/i.test(
        raw,
      ),
    truncated:
      /output (?:was )?truncated|Output exceeded|\[\.\.\. .*not shown/i.test(
        raw,
      ),
  };
}

export class ValidationCapture {
  private commands = new Map<string, CommandEvidence>();
  private sessions = new Map<string, string>();
  private gaps = new Set<string>();
  private seen = new Set<string>();
  private malformed = 0;
  private outputHashes = new WeakMap<
    CommandEvidence,
    ReturnType<typeof createHash>
  >();
  private rawCommands = new WeakMap<CommandEvidence, string>();
  private streamThread?: string;
  private sourceThreads = new Map<string, string>();
  private turnDirectories = new Map<string, string>();
  private pendingContexts = new Map<
    string,
    { start: number; contexts: ExecutionContext[] }
  >();
  private contexts: (ExecutionContext & { start: number; end: number })[] = [];
  private unknownContextWindows: { start: number; end: number }[] = [];
  constructor(
    private readonly options: {
      cwd: string;
      repo?: string;
      origin?: ValidationEvidence["origin"];
      redact?: (text: string) => string;
      observe?: () => TreeObservation | undefined;
    },
  ) {}

  private observe(): TreeObservation | undefined {
    try {
      return this.options.observe?.();
    } catch {
      this.gaps.add("An execution-time content observation failed.");
      return;
    }
  }

  line(line: string, source = "live-execution-stream", live = true): void {
    if (!line.trim()) return;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      this.malformed++;
      return;
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      this.malformed++;
      return;
    }
    if (live && j.type === "thread.started" && typeof j.thread_id === "string")
      this.streamThread ??= j.thread_id;
    if (!live && j.type === "session_meta" && typeof j.payload?.id === "string")
      this.sourceThreads.set(source, j.payload.id);
    if (
      !live &&
      j.type === "turn_context" &&
      typeof j.payload?.cwd === "string"
    )
      this.turnDirectories.set(source, j.payload.cwd);
    if (
      !live &&
      this.streamThread &&
      this.sourceThreads.get(source) === this.streamThread &&
      j.type === "response_item"
    ) {
      const p = j.payload ?? {},
        key = `${source}:${p.call_id}`;
      if (["custom_tool_call", "function_call"].includes(p.type)) {
        const input = p.arguments ?? p.input;
        const orchestrated =
          /^(?:functions\.)?exec$/.test(p.name ?? "") &&
          typeof input === "string" &&
          (p.type === "custom_tool_call" || !/^\s*\{/.test(input));
        const poll =
          /^(?:functions\.)?(?:wait|write_stdin)$/.test(p.name ?? "") &&
          /(?:cell_id|session_id)/.test(String(input));
        if (orchestrated || poll) {
          this.pendingContexts.set(key, {
            start: Date.parse(j.timestamp),
            contexts: orchestrated
              ? staticExecutionContexts(input, this.turnDirectories.get(source))
              : [],
          });
          return; // JavaScript orchestration and polling are not shell executions.
        }
      } else if (
        ["custom_tool_call_output", "function_call_output"].includes(p.type) &&
        this.pendingContexts.has(key)
      ) {
        const pending = this.pendingContexts.get(key)!;
        this.pendingContexts.delete(key);
        const end = Date.parse(j.timestamp);
        if (
          Number.isFinite(pending.start) &&
          Number.isFinite(end) &&
          end >= pending.start
        )
          if (
            pending.contexts.length &&
            /^Script (?:completed|running)\b/.test(textOf(p.output).trimStart())
          )
            this.contexts.push(
              ...pending.contexts.map((c) => ({
                ...c,
                start: pending.start,
                end,
              })),
            );
          else this.unknownContextWindows.push({ start: pending.start, end });
        return;
      }
    }
    if (
      j.type === "assistant" &&
      j.message?.content?.some?.((p: any) => ["Agent", "Task"].includes(p.name))
    ) {
      this.gaps.add(
        "Delegated executions may have incomplete transcripts or unknown tested content.",
      );
    }
    for (const e of events(j)) {
      if (typeof e.id !== "string" || !e.id) continue;
      const key = `${e.id}:${e.phase}:${hash(line)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const id = e.aliasSession
        ? (this.sessions.get(e.aliasSession) ?? e.id)
        : e.id;
      let c = this.commands.get(id);
      // Root transcript arguments can enrich the exact live invocation ID.
      if (
        c &&
        e.cwd &&
        c.cwd.startsWith("unknown") &&
        (live ||
          (this.streamThread &&
            this.sourceThreads.get(source) === this.streamThread)) &&
        (!e.command ||
          displaysCommand(this.rawCommands.get(c) ?? c.command, e.command))
      ) {
        c.cwd = (this.options.redact ?? redactEvidence)(e.cwd);
        c.cwdSource = "recorded-tool-arguments";
      }
      if (!c && new Set(this.commands.values()).size >= 500) {
        this.gaps.add(
          "Execution capture exceeded 500 records; further commands were omitted.",
        );
        continue;
      }
      const redact = this.options.redact ?? redactEvidence;
      if (e.phase === "start") {
        if (!e.command) continue;
        if (!c) {
          c = {
            id: `V${this.commands.size + 1}`,
            source: `execution-record:${hash(source + ":" + e.id).slice(0, 24)}`,
            command: redact(e.command),
            cwd: e.cwd
              ? redact(e.cwd)
              : `unknown (writer root: ${redact(this.options.cwd)})`,
            startedAt: e.at ?? (live ? new Date().toISOString() : undefined),
            outcome: "unknown",
            output: "",
            truncated: false,
            ...(live ? { before: this.observe() } : {}),
          };
          this.commands.set(id, c);
          this.rawCommands.set(c, e.command);
        }
        if (e.aliasSession && id !== e.id) this.commands.set(e.id, c);
      } else {
        if (!c && e.command) {
          c = {
            id: `V${this.commands.size + 1}`,
            source: `execution-record:${hash(source + ":" + e.id).slice(0, 24)}`,
            command: redact(e.command),
            cwd: e.cwd
              ? redact(e.cwd)
              : `unknown (writer root: ${redact(this.options.cwd)})`,
            outcome: "unknown",
            output: "",
            truncated: false,
          };
          this.commands.set(id, c);
          this.rawCommands.set(c, e.command);
        }
        if (!c) continue; // Unrelated tools and result-only messages aren't shell evidence.
        const out = outputFacts(e.output ?? "");
        if (out.ambiguous)
          this.gaps.add(
            "A grouped tool result contains multiple process statuses; no single check exit code was assigned.",
          );
        const redacted = redact(out.text);
        const digest = this.outputHashes.get(c) ?? createHash("sha256");
        digest.update(redacted).update("\n");
        this.outputHashes.set(c, digest);
        c.outputSha256 = digest.copy().digest("hex");
        const full = c.output + (c.output ? "\n" : "") + redacted;
        c.truncated ||= out.truncated || full.length > OUTPUT_LIMIT;
        c.output =
          full.length > OUTPUT_LIMIT
            ? full.slice(0, OUTPUT_LIMIT / 2) +
              "\n[output truncated]\n" +
              full.slice(-OUTPUT_LIMIT / 2)
            : full;
        if (out.session) this.sessions.set(out.session, id);
        const code = e.exitCode ?? out.code;
        if (code !== undefined) c.exitCode = code;
        c.outcome =
          e.interrupted || out.interrupted
            ? "interrupted"
            : e.error || (code !== undefined && code !== 0)
              ? "tool-error"
              : out.session && code === undefined
                ? "unknown"
                : "completed";
        if (c.outcome !== "unknown") {
          c.completedAt = e.at ?? (live ? new Date().toISOString() : undefined);
          if (live) c.after = this.observe();
        }
      }
    }
  }

  gap(reason: string): void {
    this.gaps.add(reason);
  }

  finish(finalTree?: TreeObservation): ValidationEvidence {
    // Stream and persisted session formats may describe the same invocation.
    const unique = [...new Set(this.commands.values())];
    for (const c of unique)
      if (c.cwd.startsWith("unknown") && c.startedAt) {
        const started = Date.parse(c.startedAt);
        if (
          this.unknownContextWindows.some(
            (h) => started >= h.start - 1000 && started <= h.end + 1000,
          )
        )
          continue;
        // A small ingestion delay is tolerated only when every matching explicit context agrees.
        const candidates = this.contexts.filter(
          (h) =>
            started >= h.start - 1000 &&
            started <= h.end + 1000 &&
            displaysCommand(this.rawCommands.get(c) ?? c.command, h.command),
        );
        const directories = new Set(candidates.map((h) => h.cwd));
        const unambiguous =
          candidates.length === 1 &&
          unique.filter(
            (other) =>
              other.startedAt &&
              Date.parse(other.startedAt) >= candidates[0]!.start - 1000 &&
              Date.parse(other.startedAt) <= candidates[0]!.end + 1000 &&
              displaysCommand(
                this.rawCommands.get(other) ?? other.command,
                candidates[0]!.command,
              ),
          ).length === 1;
        if (directories.size === 1 && unambiguous) {
          c.cwd = (this.options.redact ?? redactEvidence)([...directories][0]!);
          c.cwdSource = candidates[0]!.cwdSource ?? "recorded-tool-arguments";
        }
      }
    const commands: CommandEvidence[] = [];
    for (const c of unique) {
      const existing = commands.find(
        (p) =>
          p.command === c.command &&
          p.outputSha256 === c.outputSha256 &&
          p.startedAt === c.startedAt,
      );
      if (!existing) {
        const normalized = canonicalCheck(
          this.rawCommands.get(c) ?? c.command,
          c.cwd,
          this.options.repo,
        );
        const check = normalized
          ? checkExecution(normalized, c.output)
          : undefined;
        if (check?.argv)
          check.argv = check.argv.map((a) =>
            (this.options.redact ?? redactEvidence)(a),
          );
        commands.push({
          ...c,
          id: `V${commands.length + 1}`,
          ...(check ? { check } : {}),
        });
      }
    }
    if (this.malformed)
      this.gaps.add(
        `${this.malformed} non-JSON or malformed trace lines could not be interpreted.`,
      );
    if (!commands.length)
      this.gaps.add(
        "No fresh shell executions were captured; check claims cannot be established from absence.",
      );
    if (
      commands.some(
        (c) => c.outcome === "unknown" || c.outcome === "interrupted",
      )
    )
      this.gaps.add("Some executions have no completed result.");
    if (commands.some((c) => c.truncated))
      this.gaps.add("Some command output was truncated.");
    if (commands.some((c) => !c.before || !c.after))
      this.gaps.add(
        "Some tested revisions are unknown: execution-time content observations are unavailable.",
      );
    if (commands.some((c) => c.cwd.startsWith("unknown")))
      this.gaps.add(
        "Some execution working directories were not reported; only the writer root is known.",
      );
    if (!finalTree)
      this.gaps.add("Final worktree content could not be fingerprinted.");
    return {
      schema: VALIDATION_SCHEMA,
      origin: this.options.origin ?? "writer-run",
      coverage: !commands.length
        ? "unavailable"
        : this.gaps.size
          ? "partial"
          : "recorded",
      scope: "observed tool executions; not an attestation of test correctness",
      gaps: [...this.gaps],
      commands,
      finalTree,
    };
  }
}

function traceFiles(root: string, onError: () => void): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((f) =>
      f.isDirectory()
        ? traceFiles(join(root, f.name), onError)
        : f.isFile() && f.name.endsWith(".jsonl")
          ? [join(root, f.name)]
          : [],
    );
  } catch {
    onError();
    return [];
  }
}

/** Snapshot original logs so copied work sessions never become fresh writer evidence. */
export function startValidationCapture(
  sandbox: Sandbox,
  env: Record<string, string | undefined> = sandbox.env,
) {
  const started = Date.now();
  const roots = [
    join(sandbox.home, ".claude", "projects"),
    join(sandbox.codexHome, "sessions"),
  ];
  const initialGaps: string[] = [];
  const initial = new Map<string, string | null>();
  const initialMarks = new Map<string, { size: number; mtimeMs: number }>();
  for (const p of roots.flatMap((root) =>
    traceFiles(root, () =>
      initialGaps.push("An original session directory could not be inspected."),
    ),
  )) {
    try {
      const stat = lstatSync(p);
      initialMarks.set(p, { size: stat.size, mtimeMs: stat.mtimeMs });
      initial.set(p, stat.size > TRACE_LIMIT ? null : readFileSync(p, "utf8"));
    } catch {
      initial.set(p, null);
    }
  }
  const paths: [string, string][] = [
    [sandbox.repo, "<repo>"],
    [sandbox.root, "<sandbox>"],
  ];
  const secrets = Object.entries(env)
    .filter(
      ([k, v]) =>
        /TOKEN|PASSWORD|SECRET|API_KEY/i.test(k) && typeof v === "string",
    )
    .map(([, v]) => v!);
  const capture = new ValidationCapture({
    cwd: "<repo>",
    repo: sandbox.repo,
    observe: () => observeTree(sandbox.repo),
    redact: (s) => redactEvidence(s, paths, secrets),
  });
  for (const gap of initialGaps) capture.gap(gap);
  return {
    line: (s: string) => capture.line(s),
    finish: (opts: {
      timedOut: boolean;
      outputComplete?: boolean;
    }): ValidationEvidence => {
      for (const file of roots.flatMap((root) =>
        traceFiles(root, () =>
          capture.gap("A fresh session directory could not be inspected."),
        ),
      )) {
        try {
          const stat = lstatSync(file),
            mark = initialMarks.get(file);
          const old = initial.get(file);
          if (
            old === null &&
            mark?.size === stat.size &&
            mark.mtimeMs === stat.mtimeMs
          )
            continue; // unchanged large original log
          if (old === null) {
            capture.gap(
              "An original session could not be snapshotted and was excluded from fresh evidence.",
            );
            continue;
          }
          if (stat.size > TRACE_LIMIT) {
            capture.gap("A fresh trace exceeded the capture size limit.");
            continue;
          }
          const text = readFileSync(file, "utf8");
          if (old === text) continue;
          if (old !== undefined && !text.startsWith(old)) {
            capture.gap(
              "A pre-existing session was rewritten; it was excluded from fresh evidence.",
            );
            continue;
          }
          for (const line of text.slice(old?.length ?? 0).split("\n")) {
            if (!line.trim()) continue;
            let at: number;
            try {
              const event = JSON.parse(line);
              // Context metadata supplies identity/defaults, never an execution result.
              // Original copied bytes remain excluded by the prefix snapshot above.
              if (["session_meta", "turn_context"].includes(event.type)) {
                capture.line(line, relative(sandbox.root, file), false);
                continue;
              }
              at = Date.parse(event.timestamp);
            } catch {
              capture.gap("Malformed fresh transcript events were excluded.");
              continue;
            }
            if (!Number.isFinite(at)) {
              capture.gap(
                "Untimed persisted events were excluded from fresh evidence.",
              );
              continue;
            }
            if (at < started || at > Date.now()) continue;
            capture.line(line, relative(sandbox.root, file), false);
          }
        } catch {
          capture.gap("A fresh session transcript could not be read.");
        }
      }
      if (opts.timedOut)
        capture.gap(
          "The writer timed out; capture may end before check completion.",
        );
      if (opts.outputComplete === false)
        capture.gap("The writer output stream did not drain completely.");
      return capture.finish(observeTree(sandbox.repo));
    },
  };
}
