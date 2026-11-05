// Never run the writer's fake gh path inside a judge, whose environment has no fake gh.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Optional timing spans so tests can measure how many runs overlapped.
if (!process.argv.includes("--version") && process.env.FAKE_CODEX_SPANS) {
  const spans = process.env.FAKE_CODEX_SPANS,
    start = Date.now(),
    kind = process.argv.includes("-o") ? "judge" : "writer";
  process.on("exit", () =>
    appendFileSync(
      spans,
      JSON.stringify({ pid: process.pid, kind, start, end: Date.now() }) + "\n",
    ),
  );
  const delay = Number(process.env.FAKE_CODEX_DELAY_MS ?? 0);
  if (delay) await Bun.sleep(delay);
}
if (!process.argv.includes("--version")) {
  const prompt = readFileSync(0, "utf8");
  if (prompt.startsWith("Without running any tools, print the absolute path")) {
    const path = join(process.cwd(), ".agents/skills/tracetoon/SKILL.md");
    const enabled = Boolean(process.env.TRACETOON_CONFIG);
    const catalogue =
      "### Available skills\n" +
      (enabled
        ? `- tracetoon: Synthetic skill. (file: ${path})`
        : "- sample: An unrelated skill. (file: /sample/SKILL.md)");
    const dir = join(process.env.CODEX_HOME!, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fresh.jsonl"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ text: catalogue }],
        },
      }),
    );
    if (process.env.FAKE_CODEX_LOG)
      appendFileSync(
        process.env.FAKE_CODEX_LOG,
        JSON.stringify({ prompt, probe: true }) + "\n",
      );
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: enabled ? path : "NONE" },
      }),
    );
    console.log(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    );
    process.exit(0);
  }
  process.env.FAKE_CODEX_PROMPT = prompt;
}
if (
  !process.argv.includes("-o") &&
  !process.argv.includes("--version") &&
  process.env.TRACETOON_CONFIG
) {
  const gitDir = Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"])
    .stdout.toString()
    .trim();
  const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    .stdout.toString()
    .trim();
  const run = join(gitDir, "tracetoon", "runs", "20260101-000000");
  mkdirSync(run, { recursive: true });
  writeFileSync(
    join(run, "task.json"),
    JSON.stringify({
      root: process.cwd(),
      branch,
      startedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(run, "timings.json"),
    JSON.stringify([
      { stage: "digest", durationMs: 7 },
      { stage: "context", durationMs: 3 },
    ]),
  );
}
process.env.FAKE_CODEX_MODE = process.argv.includes("-o")
  ? "nothing"
  : "native";
await import("./fake-codex.ts");
export {};
