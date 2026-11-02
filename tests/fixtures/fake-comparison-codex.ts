// Never run the writer's fake gh path inside a judge, whose environment has no fake gh.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (
  !process.argv.includes('-o') &&
  !process.argv.includes('--version') &&
  process.env.TRACETOON_CONFIG
) {
  const gitDir = Bun.spawnSync(['git', 'rev-parse', '--absolute-git-dir'])
    .stdout.toString()
    .trim();
  const branch = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    .stdout.toString()
    .trim();
  const run = join(gitDir, 'tracetoon', 'runs', '20260101-000000');
  mkdirSync(run, { recursive: true });
  writeFileSync(
    join(run, 'task.json'),
    JSON.stringify({
      root: process.cwd(),
      branch,
      startedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(run, 'timings.json'),
    JSON.stringify([
      { stage: 'digest', durationMs: 7 },
      { stage: 'context', durationMs: 3 },
    ]),
  );
}
process.env.FAKE_CODEX_MODE = process.argv.includes('-o')
  ? 'nothing'
  : 'native';
await import('./fake-codex.ts');
export {};
