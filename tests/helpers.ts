import { setDefaultTimeout } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Sandbox tests run git several times and can pass 5s on a busy machine.
// bunfig.toml sets the same; this covers runs that don't pick it up.
setDefaultTimeout(30_000);

export const ROOT = resolve(import.meta.dir, '..');
export const CASES = join(ROOT, 'cases');
export const EXAMPLE = join(CASES, 'example-greet-default');

const temps: string[] = [];
/**
 * Removes every temp dir made so far. A hook registered here would attach to
 * only one test file when several run together, so each test file registers
 * `afterAll(cleanupTemps)` itself.
 */
export function cleanupTemps(): void {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

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
