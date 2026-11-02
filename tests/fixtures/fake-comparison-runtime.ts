import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === 'build-info') {
  console.log(
    JSON.stringify({ version: '0.0.0-test', buildId: 'a'.repeat(64) }),
  );
} else if (process.argv[2] === 'hook') {
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  writeFileSync(
    join(process.env.CODEX_HOME!, 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ command: process.execPath + ' hook pre-pr' }] },
        ],
      },
    }),
  );
} else process.exitCode = 1;
