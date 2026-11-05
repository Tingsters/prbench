/** Versioned, checksum-pinned case downloads. Installing data never executes it. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { caseDirs, loadCase } from './schema/case.ts';
import registry from '../datasets/registry.json';

export interface DatasetRelease {
  id: string;
  version: string;
  description: string;
  url: string;
  sha256: string;
  manifestSha256: string;
  bytes: number;
  cases: { dev: string[]; test: string[] };
}
export interface DatasetManifest {
  schema: 'prbench.dataset/v1';
  id: string;
  version: string;
  cases: { dev: string[]; test: string[] };
  preparation: string;
  files: Record<string, { sha256: string; bytes: number }>;
}
export const datasetReleases = registry.datasets as DatasetRelease[];
export const defaultDataset = registry.default;
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sha = /^[a-f0-9]{64}$/;
const simple = /^[a-z0-9][a-z0-9.-]*$/;
export function datasetRelease(spec = defaultDataset): DatasetRelease {
  const found = datasetReleases.find(d => `${d.id}@${d.version}` === spec);
  if (!found) throw new Error(`Unknown dataset ${spec}; use prbench datasets list for pinned versions.`);
  return found;
}
function safeName(name: string): boolean {
  return !!name && !name.includes('\\') && !name.includes(':') && !name.includes('\0') &&
    name.split('/').every(p => !!p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
function checkRelease(d: DatasetRelease) {
  if (!simple.test(d.id) || !simple.test(d.version) || !sha.test(d.sha256) || !sha.test(d.manifestSha256) ||
      !Number.isSafeInteger(d.bytes) || d.bytes <= 0 || d.bytes > 512 * 1024 * 1024 || new URL(d.url).protocol !== 'https:')
    throw new Error('Invalid pinned dataset release.');
}
export function checkDatasetManifest(v: unknown, d: DatasetRelease): DatasetManifest {
  const m = v as DatasetManifest;
  if (!m || m.schema !== 'prbench.dataset/v1' || m.id !== d.id || m.version !== d.version ||
      JSON.stringify(m.cases) !== JSON.stringify(d.cases) || !safeName(m.preparation) ||
      !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('Dataset manifest does not match the pinned release.');
  const names = Object.keys(m.files);
  if (!names.length || names.length > 10000 || names.includes('dataset.json') || !names.includes(m.preparation))
    throw new Error('Invalid dataset file manifest.');
  let total = 0;
  const folded = new Set<string>();
  for (const [name, entry] of Object.entries(m.files)) {
    if (!safeName(name) || folded.has(name.toLowerCase()) || !entry || !sha.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Unsafe or invalid dataset member.');
    folded.add(name.toLowerCase()); total += entry.bytes;
  }
  if (total > 1024 * 1024 * 1024) throw new Error('Dataset exceeds the installed size limit.');
  const ids = [...m.cases.dev, ...m.cases.test];
  if (new Set(ids).size !== ids.length || ids.some(id => !simple.test(id) || !names.includes(`${id}/case.json`) || !names.includes(`${id}/facts-provenance.json`)))
    throw new Error('Dataset needs distinct case IDs and reviewed fact provenance.');
  return m;
}
/** Checks only declared files; case contents remain outside source control. */
export function verifyDataset(root: string, d: DatasetRelease): DatasetManifest {
  if (lstatSync(root).isSymbolicLink()) throw new Error('Dataset root must not be a symlink.');
  const manifestBytes = readFileSync(join(root, 'dataset.json'));
  if (hash(manifestBytes) !== d.manifestSha256) throw new Error('Dataset manifest checksum mismatch.');
  const m = checkDatasetManifest(JSON.parse(manifestBytes.toString()), d);
  const observed: string[] = [];
  function walk(rel = '') {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error('Dataset contains a symlink.');
      if (e.isDirectory()) walk(name);
      else if (e.isFile()) observed.push(name);
      else throw new Error('Dataset contains a non-regular entry.');
    }
  }
  walk();
  if (JSON.stringify(observed.sort()) !== JSON.stringify([...Object.keys(m.files), 'dataset.json'].sort())) throw new Error('Dataset has missing or unexpected files.');
  for (const [name, expected] of Object.entries(m.files)) {
    const b = readFileSync(join(root, name));
    if (b.length !== expected.bytes || hash(b) !== expected.sha256) throw new Error(`Dataset checksum mismatch: ${name}`);
  }
  const dirs = caseDirs(root);
  for (const dir of dirs) {
    const c = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
    for (const rel of [c.repo?.bundle, c.facts, c.original?.body, ...(c.sessions ?? []).map((s: any) => s.file)].filter(v => v !== undefined))
      if (typeof rel !== 'string' || !safeName(rel) || !m.files[`${c.id}/${rel}`]) throw new Error('Case reference escaped its declared files.');
  }
  const loaded = dirs.map(loadCase);
  if (loaded.length !== m.cases.dev.length + m.cases.test.length) throw new Error('Dataset case inventory mismatch.');
  for (const l of loaded) {
    if (l.case.excluded || !m.cases[l.case.split].includes(l.case.id)) throw new Error('Dataset split or exclusion mismatch.');
    for (const s of l.case.sessions ?? [])
      for (const line of readFileSync(join(l.dir, s.file), 'utf8').split('\n')) if (line.trim()) JSON.parse(line);
  }
  const prep = JSON.parse(readFileSync(join(root, m.preparation), 'utf8'));
  for (const id of [...m.cases.dev, ...m.cases.test]) {
    if (!prep.cases?.[id]) throw new Error(`Missing preparation profile for ${id}.`);
    for (const f of prep.cases[id].fixtures ?? []) if (!safeName(f.bundle) || !m.files[f.bundle]) throw new Error('Preparation fixture escaped the dataset.');
  }
  return m;
}
export async function installDataset(d: DatasetRelease, destination: string, fetcher: typeof fetch = fetch): Promise<string> {
  checkRelease(d);
  const dest = resolve(destination);
  if (existsSync(dest)) { verifyDataset(dest, d); return dest; }
  const parent = dirname(dest); mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, '.prbench-dataset-'));
  try {
    const response = await fetcher(d.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Dataset download failed (${response.status}).`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Dataset download has no body.');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > d.bytes) { await reader.cancel(); throw new Error('Dataset download exceeds the pinned size.'); }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== d.bytes || hash(bytes) !== d.sha256) throw new Error('Dataset archive checksum mismatch.');
    // Read regular files into memory; never extract archive links or special files.
    const entries = await new Bun.Archive(bytes).files();
    const manifestFile = entries.get('dataset.json'); if (!manifestFile) throw new Error('Dataset archive has no manifest.');
    const manifestBytes = new Uint8Array(await manifestFile.arrayBuffer());
    if (hash(manifestBytes) !== d.manifestSha256) throw new Error('Dataset manifest checksum mismatch.');
    const manifest = checkDatasetManifest(JSON.parse(Buffer.from(manifestBytes).toString()), d);
    if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify([...Object.keys(manifest.files), 'dataset.json'].sort())) throw new Error('Dataset archive inventory mismatch.');
    for (const [name, entry] of entries) {
      if (!safeName(name)) throw new Error('Unsafe dataset archive path.');
      if (name !== 'dataset.json' && entry.size !== manifest.files[name]!.bytes) throw new Error('Dataset member size mismatch.');
      const target = join(stage, name); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Uint8Array(await entry.arrayBuffer()));
    }
    verifyDataset(stage, d);
    try { renameSync(stage, dest); }
    catch (error) { if (!existsSync(dest)) throw error; verifyDataset(dest, d); }
    return dest;
  } finally {
    // stage is an owned, freshly created sibling, never an input or computed home.
    if (dirname(stage) !== parent || !stage.startsWith(join(parent, '.prbench-dataset-')) || resolve(stage) === dest) throw new Error('Invalid dataset staging cleanup target.');
    rmSync(stage, { recursive: true, force: true });
  }
}
export async function resolveDatasetInputs(opts: { cases?: string; dataset?: string; preparation?: string }) {
  if (opts.cases && opts.dataset) throw new Error('Choose --cases or --dataset, not both.');
  if (opts.cases) return { cases: opts.cases, preparation: opts.preparation };
  const d = datasetRelease(opts.dataset);
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'prbench', 'datasets', d.id, d.version);
  const root = await installDataset(d, cache);
  const m = verifyDataset(root, d);
  return { cases: root, preparation: opts.preparation ?? join(root, m.preparation) };
}
