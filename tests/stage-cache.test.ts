import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  implementationDigest,
  stageKey,
  StageCache,
} from "../src/run/cache.ts";
import { recordEvent, failureKind } from "../src/run/ledger.ts";
import { experimentStatus } from "../src/run/status.ts";
import { tempDir, cleanupTemps, ROOT } from "./helpers.ts";
import { COMPARISON_WRITER_ENTRIES } from "../src/comparison.ts";
import { systemOrder, COMPARISON_SYSTEMS } from "../src/run/schedule.ts";
afterAll(cleanupTemps);

test("real writer contract survives scope, report, judge and Git-only repairs", () => {
  const root = tempDir();
  cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
  for (const file of ["package.json", "bun.lock", "tsconfig.json"])
    cpSync(join(ROOT, file), join(root, file));
  const before = implementationDigest(root, COMPARISON_WRITER_ENTRIES);
  for (const file of [
    "src/run/agentScope.ts",
    "src/run/scopeAudit.ts",
    "src/comparison.ts",
    "src/report.ts",
    "src/judge/rubric.ts",
  ])
    writeFileSync(
      join(root, file),
      readFileSync(join(root, file), "utf8") + "\n// Evaluation-only repair\n",
    );
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "a different revision");
  expect(implementationDigest(root, COMPARISON_WRITER_ENTRIES)).toBe(before);
  const prompt = join(root, "src/systems/agentShared.ts");
  writeFileSync(
    prompt,
    readFileSync(prompt, "utf8") + "\n// Writer prompt change\n",
  );
  expect(implementationDigest(root, COMPARISON_WRITER_ENTRIES)).not.toBe(
    before,
  );
});
test("status includes interrupted attempt cleanup and counts each owner once", () => {
  const root = tempDir(),
    dir = join(root, "attempts", "sample", "001");
  mkdirSync(dir, { recursive: true });
  const status = {
    cleanup: { state: "pending", owner: { token: "owned-attempt" } },
  };
  writeFileSync(join(dir, "writer.status.json"), JSON.stringify(status));
  writeFileSync(join(root, "writer.status.json"), JSON.stringify(status));
  expect(experimentStatus(root).pendingCleanup).toBe(1);
  expect(experimentStatus(root).cleanup).toHaveLength(1);
});
test("three replicates balance each system position for every case and model", () => {
  for (let model = 0; model < 2; model++)
    for (let c = 0; c < 5; c++) {
      const orders = [1, 2, 3].map((r) => systemOrder(model, c, r));
      for (let position = 0; position < 3; position++)
        expect(new Set(orders.map((order) => order[position])).size).toBe(
          COMPARISON_SYSTEMS.length,
        );
    }
  expect(() => systemOrder(0, 0, 0)).toThrow();
});
test("type-only dependencies leave runtime stage identities unchanged", () => {
  const root = tempDir();
  writeFileSync(
    join(root, "writer.ts"),
    "import type { Facts } from './facts.ts'; export const x=1;",
  );
  writeFileSync(
    join(root, "facts.ts"),
    "export interface Facts { old: string }",
  );
  const before = implementationDigest(root, ["writer.ts"]);
  writeFileSync(
    join(root, "facts.ts"),
    "export interface Facts { changed: number }",
  );
  expect(implementationDigest(root, ["writer.ts"])).toBe(before);
  writeFileSync(
    join(root, "writer.ts"),
    "import './facts.ts'; export const x=1;",
  );
  expect(implementationDigest(root, ["writer.ts"])).not.toBe(before);
});
test("stage dependency closure excludes unrelated judging and Git metadata, detects shared changes", () => {
  const root = tempDir();
  writeFileSync(
    join(root, "writer.ts"),
    "import { x } from './shared.ts'; export const writer = x;",
  );
  writeFileSync(join(root, "shared.ts"), "export const x = 1;");
  writeFileSync(join(root, "judge.ts"), "export const rubric = 1;");
  const before = implementationDigest(root, ["writer.ts"]);
  writeFileSync(join(root, "judge.ts"), "export const rubric = 2;");
  expect(implementationDigest(root, ["writer.ts"])).toBe(before);
  writeFileSync(join(root, "shared.ts"), "export const x = 2;");
  expect(implementationDigest(root, ["writer.ts"])).not.toBe(before);
});
test("cache entries are immutable, order independent and integrity checked", () => {
  const root = tempDir(),
    cache = new StageCache(root),
    key = stageKey("writer", { b: 2, a: 1 });
  expect(key).toBe(stageKey("writer", { a: 1, b: 2 }));
  cache.put("writer", key, { body: "first" });
  expect(cache.get("writer", key)).toEqual({ body: "first" });
  expect(() => cache.put("writer", key, { body: "better" })).toThrow(
    "overwrite",
  );
  const file = join(root, "writer", `${key}.json`);
  writeFileSync(file, readFileSync(file, "utf8").replace("first", "forged"));
  expect(() => cache.get("writer", key)).toThrow("integrity");
});
test("recovery preserves failed attempt overhead and current operation state", () => {
  const root = tempDir();
  recordEvent(root, {
    stage: "writer",
    key: "sample",
    kind: "started",
    attempt: 1,
  });
  recordEvent(root, {
    stage: "writer",
    key: "sample",
    kind: "failed",
    attempt: 1,
    durationMs: 125,
    failureKind: "transient",
  });
  recordEvent(root, {
    stage: "writer",
    key: "sample",
    kind: "accepted",
    attempt: 2,
  });
  expect(experimentStatus(root)).toMatchObject({
    failedAttempts: 1,
    failedAttemptMs: 125,
    accepted: 1,
    active: [],
  });
  expect(failureKind(new Error("capacity 503"))).toBe("transient");
  expect(failureKind(new Error("refresh token invalid"))).toBe("auth");
  expect(failureKind(new Error("timed out"))).toBe("timeout");
});
