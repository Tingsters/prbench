import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentTracetoonReview } from "../src/systems/tracetoonReview.ts";
import { artifactDigest, type PRArtifact } from "../src/schema/artifact.ts";
import {
  validationSourceText,
  verifyValidationProof,
  type ValidationProof,
} from "../src/run/adjudication.ts";
import { digest } from "../src/util/hash.ts";
import { tempDir, cleanupTemps } from "./helpers.ts";
afterAll(cleanupTemps);
test("current review proof becomes stale after title, source or head changes", () => {
  const root = tempDir(),
    head = "a".repeat(40),
    review = { v: 2, inputFingerprint: "fingerprint" },
    guidance = '{"v":1}\n',
    code = { files: [{ id: "source" }] };
  const objectHash = (x: unknown) => digest(JSON.stringify(x));
  const write = (name: string, text: string) =>
    writeFileSync(join(root, name), text);
  const packet = {
    fingerprint: "fingerprint",
    headSha: head,
    title: "Title",
    body: "Body\n",
    guidanceSha256: digest(guidance),
    authorSha256: digest(""),
    codeSourcesSha256: objectHash(code),
  };
  for (const [name, value] of Object.entries({
    "review.json": review,
    "review-input.json": packet,
    "review-result.json": {
      status: "current",
      inputFingerprint: "fingerprint",
      reportSha256: objectHash(review),
    },
    "source-evidence.json": code,
  }))
    write(name, JSON.stringify(value));
  write("guidance.json", guidance);
  write("title.txt", "Title\n");
  write("final-body.md", "Body\n");
  expect(currentTracetoonReview(root, head)).toBe(true);
  write("title.txt", "Different\n");
  expect(currentTracetoonReview(root, head)).toBe(false);
  write("title.txt", "Title\n");
  write("source-evidence.json", JSON.stringify({ files: [{ id: "changed" }] }));
  expect(currentTracetoonReview(root, head)).toBe(false);
  write("source-evidence.json", JSON.stringify(code));
  expect(currentTracetoonReview(root, "b".repeat(40))).toBe(false);
  write("final-body.md", "Changed body\n");
  expect(currentTracetoonReview(root, head)).toBe(false);
});
test("fresh-validation adjudications bind to one actual artifact command", () => {
  const artifact = {
    schema: "prbench.artifact/v1",
    case: "c",
    system: "candidate",
    title: "T",
    body: "B",
    base: "a",
    commits: [],
    diff: "D",
    meta: { tool: "test", startedAt: "2026-01-01T00:00:00Z", durationMs: 1 },
    validation: {
      commands: [
        {
          id: "V1",
          command: "bun test",
          cwd: "<repo>",
          outcome: "completed",
          exitCode: 0,
          output: "2 pass, 0 fail",
        },
      ],
    },
  } as unknown as PRArtifact;
  const text = validationSourceText(artifact, "V1"),
    proof: ValidationProof = {
      kind: "validation",
      artifactDigest: artifactDigest(artifact),
      commandId: "V1",
      sha256: digest(text),
      startLine: 1,
      endLine: text.split("\n").length,
    };
  expect(() => verifyValidationProof(artifact, proof)).not.toThrow();
  expect(() =>
    verifyValidationProof(artifact, { ...proof, commandId: "V0" }),
  ).toThrow("recording summary");
  expect(() =>
    verifyValidationProof({ ...artifact, body: "Another draft" }, proof),
  ).toThrow("another artifact");
  expect(() =>
    verifyValidationProof(artifact, { ...proof, sha256: "0".repeat(64) }),
  ).toThrow("hash or range");
  expect(() =>
    verifyValidationProof(artifact, { ...proof, endLine: 9999 }),
  ).toThrow("hash or range");
});
