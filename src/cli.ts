#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { CaseError, caseDirs, loadCase, type LoadedCase } from './schema/case.ts';
import { checkArtifact } from './schema/artifact.ts';
import { runCase } from './run/runner.ts';
import { findSystem, SYSTEMS } from './systems/index.ts';

const program = new Command('prbench').description(
  'Evaluate tools that write or change the pull requests AI coding agents produce.',
);

function loadAll(root: string): { loaded: LoadedCase[]; errors: CaseError[] } {
  const loaded: LoadedCase[] = [];
  const errors: CaseError[] = [];
  for (const dir of caseDirs(root)) {
    try {
      loaded.push(loadCase(dir));
    } catch (err) {
      if (err instanceof CaseError) errors.push(err);
      else throw err;
    }
  }
  return { loaded, errors };
}

program
  .command('validate')
  .description('Check every case under a cases directory')
  .argument('[cases]', 'cases directory', 'cases')
  .action((root: string) => {
    const { loaded, errors } = loadAll(resolve(root));
    for (const l of loaded) console.log(`ok    ${l.case.id} (${l.case.mode}, ${l.case.split})`);
    for (const e of errors) console.log(`FAIL  ${e.message}`);
    if (loaded.length + errors.length === 0) {
      console.log(`no cases found under ${root}`);
      process.exitCode = 1;
    }
    if (errors.length) process.exitCode = 1;
  });

program
  .command('systems')
  .description('List the systems that can be run')
  .action(() => {
    for (const s of SYSTEMS) console.log(`${s.id.padEnd(12)} ${s.description}`);
  });

program
  .command('run')
  .description('Run a system on one case, or on every case it supports, and write PR artifacts')
  .requiredOption('-s, --system <id>', 'system to run')
  .option('-c, --case <id>', 'only this case')
  .option('--cases <dir>', 'cases directory', 'cases')
  .option('-o, --out <dir>', 'output directory', 'results/artifacts')
  .option('--keep-sandbox', 'leave sandboxes on disk for inspection')
  .action(async (opts: { system: string; case?: string; cases: string; out: string; keepSandbox?: boolean }) => {
    const system = findSystem(opts.system);
    const { loaded, errors } = loadAll(resolve(opts.cases));
    const picked = opts.case ? loaded.filter((l) => l.case.id === opts.case) : loaded;
    if (opts.case && picked.length === 0) {
      const broken = errors.find((e) => e.where.includes(opts.case!));
      throw new Error(broken ? broken.message : `no case "${opts.case}" under ${opts.cases}`);
    }
    for (const l of picked) {
      const support = system.supports(l);
      if (!support.supported) {
        console.log(`skip  ${l.case.id}: ${support.reason}`);
        continue;
      }
      const r = await runCase(l, system, {
        outDir: resolve(opts.out),
        keepSandbox: opts.keepSandbox,
        log: (m) => console.error(m),
      });
      console.log(`ok    ${l.case.id} -> ${r.path}${r.sandboxRoot ? ` (sandbox ${r.sandboxRoot})` : ''}`);
    }
  });

program
  .command('check-artifact')
  .description('Check that a file is a valid PR artifact')
  .argument('<file>')
  .action((file: string) => {
    const problems = checkArtifact(JSON.parse(readFileSync(file, 'utf8')));
    if (problems.length) {
      console.log(`FAIL  ${file}\n  ${problems.join('\n  ')}`);
      process.exitCode = 1;
    } else console.log(`ok    ${file}`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
