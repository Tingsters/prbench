import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { harnessRevision } from '../src/run/identity.ts';
import { ROOT, tempDir, cleanupTemps } from './helpers.ts';
afterAll(cleanupTemps);
test('release packages record no Git revision and never borrow an ancestor checkout', () => {
  expect(harnessRevision(ROOT)).toMatch(/^[a-f0-9]{40}$/);
  expect(harnessRevision(join(ROOT, 'src'))).toBeNull();
  expect(harnessRevision(tempDir())).toBeNull();
});
