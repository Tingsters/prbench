import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ValidationCapture,
  observeTree,
  recordedExecution,
  withRecordedDirectories,
} from "../src/agents/validation.ts";
import {
  rescoredValidation,
  verifiedCheckouts,
} from "../src/rescoreValidation.ts";
import {
  checkValidation,
  type ValidationEvidence,
} from "../src/schema/validation.ts";
import type { PRArtifact } from "../src/schema/artifact.ts";
import { exec } from "../src/util/exec.ts";
import { cleanupTemps, tempDir } from "./helpers.ts";

afterAll(cleanupTemps);
const fixtureDir = join(
  import.meta.dir,
  "fixtures",
  "codex-rollout-directories",
);
const rollout = readFileSync(join(fixtureDir, "rollout.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean);
const tree = {
  head: "a".repeat(40),
  fingerprint: "b".repeat(64),
  at: "2026-11-08T11:27:00Z",
};
const live = (
  id: string,
  command: string,
  at: string,
  done: string,
  output = "",
) => [
  JSON.stringify({
    type: "item.started",
    timestamp: at,
    item: { id, type: "command_execution", command },
  }),
  JSON.stringify({
    type: "item.completed",
    timestamp: done,
    item: {
      id,
      type: "command_execution",
      command,
      exit_code: 0,
      aggregated_output: output,
    },
  }),
];
const LIVE = [
  ...live(
    "item_1",
    "/bin/bash -lc 'bun test'",
    "2026-11-08T11:27:00.200Z",
    "2026-11-08T11:27:01.600Z",
    "3 pass\n0 fail",
  ),
  ...live(
    "item_2",
    "/bin/bash -lc 'bun x tsc --noEmit'",
    "2026-11-08T11:27:02.100Z",
    "2026-11-08T11:27:04.100Z",
  ),
  ...live(
    "item_3",
    "/bin/bash -lc 'bun test > out.txt'",
    "2026-11-08T11:27:05.100Z",
    "2026-11-08T11:27:05.300Z",
  ),
];

function capture(rolloutLines: string[], root = "/sandbox/work/repo") {
  const c = new ValidationCapture({
    cwd: "<repo>",
    observe: () => tree,
    redact: (s) => s.replaceAll(root, "<repo>"),
  });
  c.line(JSON.stringify({ type: "thread.started", thread_id: "thread-root" }));
  for (const line of LIVE) c.line(line);
  for (const line of rolloutLines)
    c.line(line.replaceAll("<repo>", root), "rollout", false);
  return c.finish(tree);
}

test("Codex rollout command records parse with their directory and time span", () => {
  const r = recordedExecution(JSON.parse(rollout[3]!))!;
  expect(r).toMatchObject({
    id: "exec-1",
    cwd: "<repo>/pkg",
    command: "/bin/bash -lc bun test",
  });
  expect(r.end - r.start).toBe(1400);
  expect(
    recordedExecution({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "AgentMessage", id: "x" },
      },
    }),
  ).toBeUndefined();
  const windows = JSON.parse(rollout[3]!);
  windows.payload.item.cwd = "file:///C:/work/my%20repo";
  expect(recordedExecution(windows)!.cwd).toBe("C:/work/my repo");
  const untimed = JSON.parse(rollout[3]!);
  delete untimed.payload.item.duration;
  expect(recordedExecution(untimed)).toBeUndefined();
});

test("live Codex commands take the directory the rollout recorded, mapped to <repo>", () => {
  const evidence = capture(rollout);
  expect(checkValidation(evidence)).toEqual([]);
  const [test1, tsc, redirected] = evidence.commands;
  expect(test1).toMatchObject({
    cwd: "<repo>/pkg",
    cwdSource: "recorded-command-execution",
  });
  expect(test1!.check).toMatchObject({
    kind: "check",
    argv: ["bun", "test"],
    cwd: "pkg",
    execution: "fresh",
  });
  // No workdir: the session's directory, as the runtime recorded it.
  expect(tsc).toMatchObject({
    cwd: "<repo>",
    cwdSource: "recorded-command-execution",
  });
  expect(tsc!.check).toMatchObject({
    kind: "check",
    argv: ["bun", "x", "tsc", "--noEmit"],
    cwd: ".",
  });
  // Rules are not weakened: a redirection still makes a command non-canonical.
  expect(redirected!.cwd).toBe("<repo>");
  expect(redirected!.check).toEqual({
    kind: "unknown",
    reason: "Validation command contains shell expressions or redirections.",
  });
  expect(evidence.gaps.join("\n")).not.toContain(
    "working directories were not reported",
  );
  // The records are directories, not extra executions.
  expect(evidence.commands).toHaveLength(3);
});

test("records that disagree, miss the time window or are fewer than the commands leave the directory unknown", () => {
  // Records only, so static orchestration contexts can't supply the directory.
  const records = rollout.filter((l) => !l.includes('"response_item"'));
  expect(capture(records).commands[0]!.cwd).toBe("<repo>/pkg");
  const conflicting = [...records];
  const other = JSON.parse(rollout[3]!);
  other.payload.item.id = "exec-1b";
  other.payload.item.cwd = "file://<repo>/elsewhere";
  conflicting.splice(3, 0, JSON.stringify(other));
  expect(capture(conflicting).commands[0]!.cwd).toStartWith("unknown");

  const late = [...records];
  const moved = JSON.parse(rollout[3]!);
  moved.timestamp = "2026-11-08T11:30:00.000Z";
  late[late.indexOf(rollout[3]!)] = JSON.stringify(moved);
  expect(capture(late).commands[0]!.cwd).toStartWith("unknown");

  const c = new ValidationCapture({ cwd: "<repo>", observe: () => tree });
  for (const id of ["a", "b"])
    for (const line of live(
      id,
      "/bin/bash -lc 'bun test'",
      "2026-11-08T11:27:00.300Z",
      "2026-11-08T11:27:01.500Z",
    ))
      c.line(line);
  c.line(rollout[3]!, "rollout", false);
  expect(
    c.finish(tree).commands.every((x) => x.cwd.startsWith("unknown")),
  ).toBe(true);
});

const saved = (): ValidationEvidence => ({
  schema: "prbench.validation/v1",
  origin: "writer-run",
  coverage: "partial",
  scope: "observed tool executions; not an attestation of test correctness",
  gaps: [
    "Some execution working directories were not reported; only the writer root is known.",
  ],
  commands: [
    {
      id: "V1",
      source: "execution-record:1",
      command: "/bin/bash -lc 'bun run bundle'",
      cwd: "unknown (writer root: <repo>)",
      startedAt: "2026-11-08T11:27:00.200Z",
      completedAt: "2026-11-08T11:27:01.600Z",
      exitCode: 0,
      outcome: "completed",
      output: "",
      truncated: false,
      check: { kind: "unknown", reason: "Validation directory is unknown." },
      before: tree,
      after: tree,
    },
    {
      id: "V2",
      source: "execution-record:2",
      command: "/bin/bash -lc 'bun x tsc --noEmit'",
      cwd: "unknown (writer root: <repo>)",
      startedAt: "2026-11-08T11:27:02.100Z",
      outcome: "completed",
      exitCode: 0,
      output: "",
      truncated: false,
      check: { kind: "unknown", reason: "Validation directory is unknown." },
    },
  ],
  finalTree: tree,
});

test("saved evidence recovers recorded directories from retained traces without changing the original", () => {
  const lines = rollout.map((l) =>
    l
      .replace('"bun test"]', '"bun run bundle"]')
      .replace("<repo>/pkg", "<repo>"),
  );
  const original = saved(),
    snapshot = JSON.stringify(original);
  const recovered = withRecordedDirectories(original, lines);
  expect(JSON.stringify(original)).toBe(snapshot);
  expect(checkValidation(recovered)).toEqual([]);
  expect(recovered.commands[1]).toMatchObject({
    cwd: "<repo>",
    cwdSource: "recorded-command-execution",
  });
  expect(recovered.commands[1]!.check).toMatchObject({
    kind: "check",
    argv: ["bun", "x", "tsc", "--noEmit"],
    cwd: ".",
  });
  // A package script still needs its source: without the validated bytes it stays unknown.
  expect(recovered.commands[0]!.check).toEqual({
    kind: "unknown",
    reason: "Package-script source is unavailable.",
  });
  expect(recovered.gaps).not.toContain(original.gaps[0]);
  expect(recovered.gaps.at(-1)).toContain("recovered after the run");
  expect(withRecordedDirectories(original, ["{}"])).toBe(original);
});

test("re-scoring resolves package scripts only against a checkout matching the final tree", () => {
  const dir = tempDir("prbench-rescore-test-"),
    repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { bundle: "bun scripts/bundle.ts" } }),
  );
  writeFileSync(
    join(repo, "scripts", "bundle.ts"),
    "console.log('bundled');\n",
  );
  const git = (...args: string[]) => {
    const r = exec([
      "git",
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      ...args,
    ]);
    if (r.code) throw new Error(r.stderr);
  };
  exec(["git", "init", "--quiet", repo]);
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  git("bundle", "create", "--quiet", join(dir, "repo.bundle"), "--all");
  const final = observeTree(repo)!;
  const traces = join(dir, "tracetoon-baseline.traces");
  mkdirSync(traces);
  writeFileSync(
    join(traces, "rollout.jsonl"),
    rollout
      .map((l) =>
        l
          .replace('"bun test"]', '"bun run bundle"]')
          .replace("<repo>/pkg", "<repo>"),
      )
      .join("\n"),
  );
  const evidence = saved();
  evidence.finalTree = final;
  const artifact = { validation: evidence } as PRArtifact;
  const checkouts = verifiedCheckouts();
  try {
    const bundled = rescoredValidation(artifact, traces, (t) =>
      checkouts.get(join(dir, "repo.bundle"), t),
    )!;
    expect(bundled.commands[0]!.check).toMatchObject({
      kind: "check",
      argv: ["bun", "scripts/bundle.ts"],
      cwd: ".",
    });
    expect(bundled.commands[0]!.check!.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    // Different validated bytes: the checkout isn't used.
    expect(
      checkouts.get(join(dir, "repo.bundle"), {
        ...final,
        fingerprint: "c".repeat(64),
      }),
    ).toBeUndefined();
  } finally {
    checkouts.dispose();
  }
  expect(rescoredValidation(artifact, undefined)).toBe(evidence);
});
