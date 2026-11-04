/** Retain private, redacted invocation traces before sandbox disposal. Never copy credentials. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Sandbox } from "./sandbox.ts";
import { digest } from "../util/hash.ts";
import { redactEvidence } from "../agents/validation.ts";
import { atomicJson } from "./ledger.ts";
const LIMIT = 32 * 1024 * 1024;
function files(sandbox: Sandbox) {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= 1000) break;
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        found.push(file);
    }
  };
  walk(join(sandbox.codexHome, "sessions"));
  walk(join(sandbox.home, ".claude", "projects"));
  return found;
}
export function traceSnapshot(sandbox: Sandbox) {
  const initial = new Map<string, string>();
  for (const file of files(sandbox))
    if (statSync(file).size <= LIMIT)
      initial.set(file, digest(readFileSync(file)));
  return initial;
}
export function retainTraces(
  sandbox: Sandbox,
  initial: Map<string, string>,
  out: string,
) {
  mkdirSync(out, { recursive: true });
  const gaps: string[] = [],
    entries: {
      source: string;
      file: string;
      sourceSha256: string;
      retainedSha256: string;
      truncated: boolean;
    }[] = [];
  const secrets = Object.entries(sandbox.env)
    .filter(
      ([key, value]) => !!value && /token|secret|password|api.?key/i.test(key),
    )
    .map(([, value]) => value!);
  const redact = (text: string) =>
    redactEvidence(
      text,
      [
        [sandbox.root, "<sandbox>"],
        [sandbox.repo, "<repo>"],
        [sandbox.home, "<home>"],
        [sandbox.codexHome, "<codex-home>"],
      ],
      secrets,
    );
  const clean = (value: any): any =>
    typeof value === "string"
      ? redact(value)
      : Array.isArray(value)
        ? value.map(clean)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, v]) => [key, clean(v)]),
            )
          : value;
  let total = 0;
  const candidates = files(sandbox);
  if (candidates.length >= 1000)
    gaps.push("Transcript enumeration reached the 1000-file limit.");
  for (const source of candidates) {
    const size = statSync(source).size;
    if (size > LIMIT || total + size > 128 * 1024 * 1024) {
      gaps.push("A transcript exceeded the retained trace byte limit.");
      continue;
    }
    const raw = readFileSync(source),
      sha = digest(raw);
    if (initial.get(source) === sha) continue;
    total += size;
    const lines = raw.toString("utf8").split("\n"),
      valid: string[] = [];
    let truncated = false;
    for (const line of lines.filter(Boolean)) {
      try {
        valid.push(JSON.stringify(clean(JSON.parse(line))));
      } catch {
        truncated = true;
        gaps.push(
          "An incomplete transcript record was retained as redacted diagnostic text.",
        );
        valid.push(JSON.stringify({ captureError: true, text: redact(line) }));
      }
    }
    const file = `${digest(relative(sandbox.root, source)).slice(0, 24)}.jsonl`,
      text = valid.join("\n") + "\n";
    writeFileSync(join(out, file), text, { flag: "wx", mode: 0o600 });
    entries.push({
      source: redact(source),
      file,
      sourceSha256: sha,
      retainedSha256: digest(text),
      truncated,
    });
  }
  const index = {
    schema: "prbench.retained-traces/v1",
    entries,
    gaps,
    scope:
      "Redacted diagnostic transcripts; original content hashes are provenance, not proof of execution correctness.",
  };
  atomicJson(join(out, "index.json"), index);
  return index;
}
