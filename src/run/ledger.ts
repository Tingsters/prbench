/** Durable operational history is separate from immutable quality artifacts. */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
export { digest } from "../util/hash.ts";

export type Stage =
  "preflight" | "writer" | "writer-block" | "judge" | "report" | "cleanup";
export interface LedgerEvent {
  schema: "prbench.event/v1";
  id: string;
  at: string;
  stage: Stage;
  key: string;
  kind:
    "started" | "accepted" | "failed" | "reused" | "recovered" | "cancelled";
  attempt?: number;
  durationMs?: number;
  failureKind?: string;
  detail?: string;
  artifact?: string;
}
export function atomicJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
  renameSync(temp, file);
}
export function recordEvent(
  root: string,
  event: Omit<LedgerEvent, "schema" | "id" | "at">,
): LedgerEvent {
  mkdirSync(root, { recursive: true });
  const value: LedgerEvent = {
    schema: "prbench.event/v1",
    id: randomUUID(),
    at: new Date().toISOString(),
    ...event,
  };
  appendFileSync(join(root, "events.jsonl"), JSON.stringify(value) + "\n", {
    mode: 0o600,
    flush: true,
  });
  return value;
}
export function readEvents(root: string): LedgerEvent[] {
  const file = join(root, "events.jsonl");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8"),
    lines = raw.split("\n");
  if (lines.at(-1))
    throw new Error(
      "Operational ledger has an incomplete final record; preserve it and recover before resuming.",
    );
  return lines.filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    if (event.schema !== "prbench.event/v1" || !event.id || !event.key)
      throw new Error("Invalid operational ledger.");
    return event as LedgerEvent;
  });
}
export function failureKind(
  error: unknown,
): "transient" | "auth" | "timeout" | "invalid" {
  const message = String(error);
  if (
    /unauthori[sz]ed|invalid.grant|sign.in|authentication|refresh.token|\b401\b|\b403\b/i.test(
      message,
    )
  )
    return "auth";
  if (/timed?.?out|timeout|abort/i.test(message)) return "timeout";
  return /capacity|rate.limit|\b429\b|\b50[0234]\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|temporarily unavailable|connection.*(?:closed|reset)/i.test(
    message,
  )
    ? "transient"
    : "invalid";
}
export function retryDelay(error: unknown, fallback: number): number {
  const structured = error as { retryAfterMs?: unknown; retryAfter?: unknown };
  if (
    typeof structured?.retryAfterMs === "number" &&
    Number.isFinite(structured.retryAfterMs) &&
    structured.retryAfterMs >= 0
  )
    return structured.retryAfterMs;
  const value =
    structured?.retryAfter ??
    /(?:retry[-_ ]after["']?\s*[:=]?\s*)(\d+(?:\.\d+)?)/i.exec(
      String(error),
    )?.[1];
  if (value !== undefined) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return fallback;
}
