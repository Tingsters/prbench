import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preflightCase, writerCaseIdentity } from "../src/run/preflight.ts";
import { loadCase } from "../src/schema/case.ts";
import { copyExample, tempDir, cleanupTemps } from "./helpers.ts";
import { exec } from "../src/util/exec.ts";
import { digest } from "../src/util/hash.ts";
afterAll(cleanupTemps);
test("custom bundle base anchors survive mirror inspection and repair older bare caches", () => {
  const example = copyExample("preflight-custom-base"),
    repo = join(tempDir(), "repo");
  const g = (...args: string[]) => {
    const result = exec(["git", ...args]);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  g("clone", "--quiet", join(example.dir, "repo.bundle"), repo);
  g("-C", repo, "config", "user.name", "Test");
  g("-C", repo, "config", "user.email", "test@example.invalid");
  g("-C", repo, "checkout", "--orphan", "separate-base");
  g("-C", repo, "commit", "--allow-empty", "-m", "independent base");
  const base = g("-C", repo, "rev-parse", "HEAD");
  g("-C", repo, "update-ref", "refs/prbench/base-anchor", base);
  g("-C", repo, "checkout", "--detach", "HEAD~0");
  // Detach onto the original case head, then remove the temporary branch.
  const caseFile = join(example.dir, "case.json"),
    metadata = JSON.parse(readFileSync(caseFile, "utf8"));
  g("-C", repo, "checkout", "--detach", metadata.repo.head);
  g("-C", repo, "branch", "-D", "separate-base");
  const bundle = join(example.dir, metadata.repo.bundle);
  g("-C", repo, "bundle", "create", bundle, "--all");
  metadata.repo.base = base;
  writeFileSync(caseFile, JSON.stringify(metadata));
  const loaded = loadCase(example.dir),
    cache = tempDir();
  expect(preflightCase(loaded, { cache, requireProvenance: false }).case).toBe(
    metadata.id,
  );
  const legacyCache = tempDir(),
    bare = join(legacyCache, `${digest(readFileSync(bundle))}.git`);
  g("clone", "--quiet", "--bare", bundle, bare);
  expect(
    preflightCase(loaded, { cache: legacyCache, requireProvenance: false })
      .case,
  ).toBe(metadata.id);
});
test("fact edits preserve writer identity but invalidate provenance and judging inputs", () => {
  const example = copyExample("preflight-facts"),
    loaded = loadCase(example.dir),
    cache = tempDir();
  const before = writerCaseIdentity(loaded),
    preview = preflightCase(loaded, { cache, requireProvenance: false });
  expect(preview.sessionRecords).toBeGreaterThan(0);
  const file = join(example.dir, loaded.case.facts!),
    facts = JSON.parse(readFileSync(file, "utf8"));
  facts.claims.push("Another checkable claim.");
  writeFileSync(file, JSON.stringify(facts));
  expect(writerCaseIdentity(loadCase(example.dir))).toBe(before);
  expect(
    preflightCase(loadCase(example.dir), { cache, requireProvenance: false })
      .factsSha256,
  ).not.toBe(preview.factsSha256);
  expect(() =>
    preflightCase(loadCase(example.dir), { cache, requireProvenance: true }),
  ).toThrow("provenance");
  const session = join(example.dir, loaded.case.sessions![0]!.file);
  writeFileSync(session, readFileSync(session, "utf8") + "\n");
  expect(writerCaseIdentity(loadCase(example.dir))).not.toBe(before);
});
