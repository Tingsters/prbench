// Stands in for the `tracetoon` CLI in tests: `hook install` writes a settings
// file under $HOME, the way the real command does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'hook' && args[1] === 'install') {
  const home = process.env.HOME!;
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
  process.exit(0);
}
process.stderr.write(`fake tracetoon: unsupported ${args.join(' ')}\n`);
process.exit(1);
