import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEvents, type LedgerEvent } from "./ledger.ts";
export function experimentStatus(root: string) {
  const events = readEvents(root),
    latest = new Map<string, LedgerEvent>();
  for (const event of events) latest.set(`${event.stage}:${event.key}`, event);
  const cleanupByOwner = new Map<string, { file: string; state: string }>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        entry.name === "inputs" ||
        entry.name === "derived-reports"
      )
        continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".status.json")) {
        const value = JSON.parse(readFileSync(file, "utf8"));
        const key = value.cleanup?.owner?.token ?? file;
        const item = { file, state: value.cleanup?.state ?? "unknown" };
        if (!cleanupByOwner.has(key) || item.state === "pending")
          cleanupByOwner.set(key, item);
      }
    }
  };
  if (existsSync(root)) visit(root);
  const cleanup = [...cleanupByOwner.values()];
  const stateFile = join(root, "state.json");
  return {
    schema: "prbench.status/v1",
    state: existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, "utf8"))
      : null,
    events: events.length,
    accepted: [...latest.values()].filter((e) => e.kind === "accepted").length,
    reused: events.filter((e) => e.kind === "reused").length,
    failedAttempts: events.filter((e) => e.kind === "failed").length,
    failedAttemptMs: events
      .filter((e) => e.kind === "failed")
      .reduce((sum, e) => sum + (e.durationMs ?? 0), 0),
    active: [...latest.values()].filter((e) => e.kind === "started"),
    pendingCleanup: cleanup.filter((c) => c.state === "pending").length,
    cleanup,
    warnings: events.filter(
      (e) => e.kind === "failed" || e.kind === "cancelled",
    ),
  };
}
