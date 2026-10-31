import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll } from 'bun:test';

export const ROOT = resolve(import.meta.dir, '..');
export const CASES = join(ROOT, 'cases');
export const EXAMPLE = join(CASES, 'example-greet-default');

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

export function tempDir(prefix = 'prbench-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function exampleCaseJson(): Record<string, any> {
  return JSON.parse(readFileSync(join(EXAMPLE, 'case.json'), 'utf8'));
}

/** Copies the example case into a temp cases dir under `id`, applying `edit` to its case.json. */
export function copyExample(id: string, edit: (c: Record<string, any>) => void = () => {}): { root: string; dir: string } {
  const root = tempDir('prbench-cases-');
  const dir = join(root, id);
  cpSync(EXAMPLE, dir, { recursive: true });
  const c = exampleCaseJson();
  c.id = id;
  edit(c);
  writeFileSync(join(dir, 'case.json'), JSON.stringify(c, null, 2));
  return { root, dir };
}
