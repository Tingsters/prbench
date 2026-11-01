// Historical drafts stay immutable. Recovery uses explicitly mapped execution
// logs, checks their hashes/time/context, and never executes the claimed checks.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { caseDirs, loadCase } from './schema/case.ts';
import { checkArtifact, type PRArtifact } from './schema/artifact.ts';
import { unavailableValidation } from './schema/validation.ts';
import { ValidationCapture, redactEvidence } from './agents/validation.ts';
import { RUBRIC_VERSION } from './judge/rubric.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
interface RecoveryEntry {
  case: string; system: string; artifactSha256: string; repoPath: string;
  sessions: { file: string; sha256: string }[];
}
interface RecoveryManifest { schema: 'prbench.recovery/v1'; entries: RecoveryEntry[] }

export interface EvidenceAudit {
  schema: 'prbench.evidence-audit/v1';
  rubricVersion: number;
  split: string;
  artifacts: { case: string; system: string; sourceSha256: string; draftSha256: string; coverage: string; commands: number; gaps: string[] }[];
  historicalFindings: { case: string; system: string; judge: string; order: string; rubricVersion: number | null; kind: string; claim: string; validationRelated: boolean; disposition: 'requires reassessment; original verdict preserved' }[];
  qualification: string;
}

function jsonFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((p) => p.isDirectory() ? jsonFiles(join(root, p.name)) : p.isFile() && p.name.endsWith('.json') ? [join(root, p.name)] : []);
}

function recover(a: PRArtifact, bytes: Buffer, entry: RecoveryEntry, manifestDir: string) {
  if (entry.artifactSha256 !== sha(bytes)) throw new Error(`Recovery artifact hash mismatch for ${a.case}/${a.system}`);
  if (!entry.repoPath || !Array.isArray(entry.sessions) || !entry.sessions.length) throw new Error('Recovery requires a repository path and explicitly mapped sessions');
  const started = Date.parse(a.meta.startedAt), finished = started + a.meta.durationMs;
  const capture = new ValidationCapture({ cwd: '<repo>', origin: 'historical-recovery',
    redact: (s) => redactEvidence(s, [[entry.repoPath, '<repo>']]) });
  for (const source of entry.sessions) {
    const file = resolve(manifestDir, source.file);
    const raw = readFileSync(file);
    if (raw.length > 32 * 1024 * 1024) throw new Error('Recovery transcript exceeds 32 MiB limit');
    if (sha(raw) !== source.sha256) throw new Error(`Recovery transcript hash mismatch for ${a.case}/${a.system}`);
    const lines = raw.toString('utf8').split('\n').filter(Boolean);
    const parsed = lines.map((line) => { try { return JSON.parse(line); } catch { return undefined; } });
    const normalize = (s: string) => s.replace(/\\/g, '/').replace(/\/$/, '');
    if (!parsed.some((j) => normalize(j?.payload?.cwd ?? j?.cwd ?? '') === normalize(entry.repoPath))) {
      throw new Error(`Recovery transcript lacks matching repository context for ${a.case}/${a.system}`);
    }
    let accepted = 0;
    for (let i = 0; i < lines.length; i++) {
      const at = Date.parse(parsed[i]?.timestamp);
      // Only contemporaneous events belong to this writer run. Old replayed
      // sessions and untimed summaries cannot be relabeled as fresh evidence.
      if (!Number.isFinite(at) || at < started || at > finished) continue;
      capture.line(lines[i]!, `recovered:${source.sha256}`, false); accepted++;
    }
    if (!accepted) throw new Error(`Recovery transcript has no events within ${a.case}/${a.system}'s recorded run`);
  }
  capture.gap('Recovered transcript association uses the explicit manifest, artifact hash, repository context and recorded run window; execution-time tree observations were not retained.');
  return capture.finish();
}

export function auditEvidence(opts: { artifactsDir: string; casesDir: string; outDir: string; split?: string; judgmentsDir?: string; recoveryManifest?: string }): EvidenceAudit {
  const split = opts.split ?? 'dev';
  const source = realpathSync(opts.artifactsDir), out = resolve(opts.outDir);
  const rel = relative(source, out);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Audit output must be outside the source artifact directory');
  if (existsSync(out) && readdirSync(out).length) throw new Error('Use a new, empty audit output directory to preserve historical evidence');
  const selected = new Set(caseDirs(opts.casesDir).map(loadCase).filter((l) => l.case.split === split && !l.case.excluded).map((l) => l.case.id));
  const manifest: RecoveryManifest = opts.recoveryManifest ? JSON.parse(readFileSync(opts.recoveryManifest, 'utf8')) : { schema: 'prbench.recovery/v1', entries: [] };
  if (manifest.schema !== 'prbench.recovery/v1' || !Array.isArray(manifest.entries)) throw new Error('Invalid recovery manifest');
  const seen = new Set<string>();
  for (const e of manifest.entries) {
    const key = JSON.stringify([e.case, e.system]);
    if (seen.has(key)) throw new Error('Duplicate recovery mapping');
    seen.add(key);
  }
  const audit: EvidenceAudit = { schema: 'prbench.evidence-audit/v1', rubricVersion: RUBRIC_VERSION, split, artifacts: [], historicalFindings: [],
    qualification: 'Historical unsupported verdicts can include missing fresh writer evidence. They are not fabrication rates. This audit preserves original drafts and verdicts; it does not establish whether missing checks passed. Rejudge preserved drafts under rubric v3 in a separate output directory. Checks run today cannot prove past execution.' };
  const copies: { path: string; artifact: PRArtifact }[] = [];
  for (const id of selected) {
    const dir = join(source, id);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const bytes = readFileSync(join(dir, file)), a = JSON.parse(bytes.toString()) as PRArtifact;
      const problems = checkArtifact(a);
      if (problems.length) throw new Error(`Invalid artifact ${id}/${file}: ${problems.join('; ')}`);
      if (a.case !== id || file !== `${a.system}.json` || /[\\/]/.test(a.system)) throw new Error('Artifact path/identity mismatch');
      const entry = manifest.entries.find((e) => e.case === a.case && e.system === a.system);
      const validation = entry ? recover(a, bytes, entry, dirname(resolve(opts.recoveryManifest!))) : a.validation ??
        unavailableValidation('Historical artifact has no fresh execution records; no verified artifact/log recovery mapping was supplied.');
      copies.push({ path: join(out, 'artifacts', id, file), artifact: { ...a, validation } });
      audit.artifacts.push({ case: id, system: a.system, sourceSha256: sha(bytes), draftSha256: sha(JSON.stringify([a.title, a.body])),
        coverage: validation.coverage, commands: validation.commands.length, gaps: validation.gaps });
    }
  }
  for (const entry of manifest.entries) if (!audit.artifacts.some((a) => a.case === entry.case && a.system === entry.system)) throw new Error('Recovery mapping does not match a selected artifact');
  if (opts.judgmentsDir) for (const file of jsonFiles(opts.judgmentsDir)) {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!selected.has(j.case) || !j.labels || !j.judgment) continue;
    for (const label of ['A', 'B']) for (const kind of ['factualErrors', 'unsupportedClaims']) {
      for (const claim of j.judgment[label]?.[kind] ?? []) audit.historicalFindings.push({ case: j.case, system: j.labels[label], judge: j.judge, order: j.order,
        rubricVersion: j.rubricVersion ?? null, kind, claim, validationRelated: /\b(test|tests|check|checks|pass|passed|fail|failed|build|typecheck|tsc|lint|suite|validation)\b/i.test(claim),
        disposition: 'requires reassessment; original verdict preserved' });
    }
  }
  mkdirSync(out, { recursive: true });
  for (const c of copies) { mkdirSync(dirname(c.path), { recursive: true }); writeFileSync(c.path, JSON.stringify(c.artifact, null, 2) + '\n'); }
  writeFileSync(join(out, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
  const md = ['# Validation evidence audit', '', audit.qualification, '', `Split: ${split}. Artifacts: ${audit.artifacts.length}.`, '',
    '| case | system | evidence coverage | captured commands |', '|---|---|---|---|',
    ...audit.artifacts.map((a) => `| ${a.case} | ${a.system} | ${a.coverage} | ${a.commands} |`), '',
    `${audit.historicalFindings.length} historical error/unsupported findings require reassessment; ${audit.historicalFindings.filter((f) => f.validationRelated).length} mention validation (a screening heuristic, not a corrected verdict).`, '',
    'Original inputs are unchanged. Copies under artifacts/ retain exactly the original title and body. No writer or judge model was called.', ''];
  writeFileSync(join(out, 'audit.md'), md.join('\n'));
  return audit;
}
