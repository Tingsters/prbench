import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test('historical digests bind case revisions and hashes without becoming writer inputs', () => {
  const example = copyExample('historical-record'), loaded = loadCase(example.dir), c = loaded.case;
  const file = 'fact-sources/digest.json'; mkdirSync(join(example.dir, 'fact-sources'));
  const record = { schema: 'prbench.historical-digest/v1', case: c.id, base: c.repo.base, head: c.repo.head, sourceSha256: 'a'.repeat(64), digest: { pr: { base: c.repo.base, head: c.repo.head }, stats: {} } };
  const content = JSON.stringify(record,null,2)+'\n'; writeFileSync(join(example.dir,file), content);
  const facts = JSON.parse(readFileSync(join(example.dir,c.facts!), 'utf8'));
  const ids = Object.entries({ C: facts.claims, X: facts.context, U: facts.uncertainties, T: facts.traps }).flatMap(([prefix,values]) => (values as string[]).map((_,i) => prefix+(i+1)));
  const provenance = { schema:'prbench.fact-provenance/v1', factsSha256:digest(readFileSync(join(example.dir,c.facts!))), reviewedBy:'automated test fixture', reviewKind:'automated', reviewedAt:'2026-11-05T00:00:00Z', entries:Object.fromEntries(ids.map(id=>[id,{rationale:'Synthetic historical fixture',sources:[{kind:'historical-digest',path:file,startLine:1,endLine:content.split('\n').length,sha256:digest(content)}]}])) };
  writeFileSync(join(example.dir,'facts-provenance.json'), JSON.stringify(provenance));
  const identity = writerCaseIdentity(loaded);
  expect(preflightCase(loaded,{cache:tempDir(),requireProvenance:true}).checkedFacts).toBe(ids.length);
  record.case = 'wrong-case'; writeFileSync(join(example.dir,file),JSON.stringify(record));
  expect(writerCaseIdentity(loaded)).toBe(identity);
  expect(()=>preflightCase(loaded,{cache:tempDir(),requireProvenance:true})).toThrow('identity mismatch');
});
test("concurrent controllers share one cold mirror cache without collisions", async () => {
  const example = copyExample("preflight-race"),
    cache = join(tempDir(), "preflight");
  const at = Date.now() + 1500;
  const script = `
    import { preflightCase } from ${JSON.stringify(join(import.meta.dir, "..", "src", "run", "preflight.ts"))};
    import { loadCase } from ${JSON.stringify(join(import.meta.dir, "..", "src", "schema", "case.ts"))};
    const loaded = loadCase(process.argv[1]);
    while (Date.now() < ${at}) {}
    preflightCase(loaded, { cache: process.argv[2], requireProvenance: false });
  `;
  const procs = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, "-e", script, example.dir, cache], { stdout: "pipe", stderr: "pipe" }),
  );
  const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
  for (const r of results) {
    if (r.code) console.error(r.err.slice(-1000));
    expect(r.code).toBe(0);
  }
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(cache)).toHaveLength(1);
}, 60_000);
