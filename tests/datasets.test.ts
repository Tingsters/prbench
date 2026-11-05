import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkDatasetManifest, installDataset, verifyDataset, type DatasetRelease } from '../src/datasets.ts';
import { cleanupTemps, EXAMPLE, tempDir } from './helpers.ts';
afterAll(cleanupTemps);
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function fixture(edit?: (files: Record<string, Uint8Array>) => void) {
  const c = JSON.parse(readFileSync(join(EXAMPLE, 'case.json'), 'utf8'));
  const files: Record<string, Uint8Array> = {};
  for (const name of ['case.json', c.repo.bundle, c.facts, ...(c.sessions ?? []).map((s: any) => s.file), ...(c.original ? [c.original.body] : [])])
    files[`${c.id}/${name}`] = readFileSync(join(EXAMPLE, name));
  files[`${c.id}/facts-provenance.json`] = Buffer.from('{}');
  files['preparation.json'] = Buffer.from(JSON.stringify({ cases: { [c.id]: {} } }));
  edit?.(files);
  const manifest = Buffer.from(JSON.stringify({ schema: 'prbench.dataset/v1', id: 'test-cases', version: '1.0.0', cases: { dev: [c.id], test: [] }, preparation: 'preparation.json', files: Object.fromEntries(Object.entries(files).map(([n,b]) => [n, { sha256: hash(b), bytes: b.length }])) }));
  files['dataset.json'] = manifest;
  const bytes = await new Bun.Archive(files, { compress: 'gzip' }).bytes();
  const release: DatasetRelease = { id: 'test-cases', version: '1.0.0', description: 'test', url: 'https://example.invalid/data.tar.gz', sha256: hash(bytes), manifestSha256: hash(manifest), bytes: bytes.length, cases: { dev: [c.id], test: [] } };
  return { release, bytes, files, id: c.id };
}
test('verified archive installs atomically, validates JSONL and reuses cache offline', async () => {
  const { release, bytes, id } = await fixture(); const dest = join(tempDir(), 'cases');
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(bytes); }) as unknown as typeof fetch;
  await installDataset(release, dest, fetcher);
  expect(verifyDataset(dest, release).cases.dev).toEqual([id]);
  await installDataset(release, dest, fetcher);
  expect(calls).toBe(1);
  writeFileSync(join(dest, id, 'facts.json'), '{}');
  await expect(installDataset(release, dest, fetcher)).rejects.toThrow('checksum mismatch');
});
test('corrupt or truncated download never leaves an installed dataset', async () => {
  const { release, bytes } = await fixture(); const parent = tempDir(), dest = join(parent, 'cases');
  const corrupt = bytes.slice(); corrupt[20] = corrupt[20]! ^ 1;
  await expect(installDataset(release, dest, (async () => new Response(corrupt)) as unknown as typeof fetch)).rejects.toThrow('checksum mismatch');
  expect(existsSync(dest)).toBe(false);
  await expect(installDataset(release, dest, (async () => new Response(bytes.slice(0,-1))) as unknown as typeof fetch)).rejects.toThrow('checksum mismatch');
  expect(existsSync(dest)).toBe(false);
});
test('refuses existing user data and does not overwrite it', async () => {
  const { release, bytes } = await fixture(); const dest = join(tempDir(), 'existing'); mkdirSync(dest);
  writeFileSync(join(dest, 'my-file'), 'keep');
  await expect(installDataset(release, dest, (async () => new Response(bytes)) as unknown as typeof fetch)).rejects.toThrow();
  expect(readFileSync(join(dest, 'my-file'), 'utf8')).toBe('keep');
});
test('manifest changes cannot bless tampered cached data', async () => {
  const { release, bytes } = await fixture(); const dest = join(tempDir(), 'cases');
  await installDataset(release, dest, (async () => new Response(bytes)) as unknown as typeof fetch);
  const m = JSON.parse(readFileSync(join(dest, 'dataset.json'), 'utf8')); m.files['preparation.json'].sha256 = '0'.repeat(64);
  writeFileSync(join(dest, 'dataset.json'), JSON.stringify(m));
  expect(() => verifyDataset(dest, release)).toThrow('manifest checksum mismatch');
});
test('archive member paths and case references cannot escape the installation', async () => {
  const f = await fixture(); const m = JSON.parse(Buffer.from(f.files['dataset.json']!).toString());
  for (const path of ['../escape', '/absolute', 'C:/outside', 'a\\b', 'CON/file', 'trailing./file']) {
    const bad = structuredClone(m); bad.files[path] = { bytes: 0, sha256: hash(new Uint8Array()) };
    expect(() => checkDatasetManifest(bad, f.release)).toThrow('Unsafe');
  }
  const escaped = await fixture(files => {
    const name = Object.keys(files).find(n => n.endsWith('/case.json'))!;
    const c = JSON.parse(Buffer.from(files[name]!).toString()); c.facts = '../outside.json'; files[name] = Buffer.from(JSON.stringify(c));
  });
  await expect(installDataset(escaped.release, join(tempDir(), 'cases'), (async () => new Response(escaped.bytes)) as unknown as typeof fetch)).rejects.toThrow('escaped');
});
