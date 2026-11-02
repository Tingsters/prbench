/** Reproducible, serial comparisons. Only adapters see writer inputs; answer keys stay in judging. */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { codexCommand } from './agents/codexAuth.ts';
import { codexSystem } from './systems/codex.ts';
import { PR_PROMPT } from './systems/agentShared.ts';
import { runCase } from './run/runner.ts';
import type { Sandbox } from './run/sandbox.ts';
import {
  artifactDigest,
  checkArtifact,
  type PRArtifact,
} from './schema/artifact.ts';
import {
  caseDirs,
  loadCase,
  loadFacts,
  type LoadedCase,
} from './schema/case.ts';
import { judgePair, type PairResult } from './judge/pairwise.ts';
import { parseJudge } from './judge/providers.ts';
import { RUBRIC_VERSION } from './judge/rubric.ts';
import { buildReport, reportMarkdown, type Report } from './report.ts';
import { exec, git } from './util/exec.ts';

const MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra'];
const JUDGES = MODELS.map((m) => `codex:${m}@medium`);
const SYSTEMS = ['codex-native', 'tracetoon-baseline', 'tracetoon-candidate'];
const hash = (x: string | Buffer) =>
  createHash('sha256').update(x).digest('hex');
const json = <T = any>(file: string): T =>
  JSON.parse(readFileSync(file, 'utf8'));
const save = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

export function directoryDigest(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`Immutable inputs cannot contain symlinks: ${rel}`);
      if (entry.isDirectory()) walk(rel);
      else
        h.update(rel)
          .update('\0')
          .update(readFileSync(join(root, rel)))
          .update('\0');
    }
  };
  walk('');
  return h.digest('hex');
}

export interface RuntimeIdentity {
  version: string;
  buildId: string;
  sha256: string;
}
export function runtimeIdentity(
  skill: string,
  runtime: string,
): RuntimeIdentity {
  const result = exec([runtime, 'build-info', '--json']);
  if (result.code)
    throw new Error(`Pinned runtime failed build-info: ${result.stderr}`);
  const info = JSON.parse(result.stdout),
    manifest = json(join(skill, 'build.json'));
  if (typeof info.version !== 'string' || !/^[a-f0-9]{64}$/.test(info.buildId))
    throw new Error('Pinned runtime has malformed build identity.');
  if (info.version !== manifest.version || info.buildId !== manifest.buildId)
    throw new Error('Pinned runtime and skill build identities differ.');
  return {
    version: info.version,
    buildId: info.buildId,
    sha256: hash(readFileSync(runtime)),
  };
}

interface Preparation {
  cases: Record<
    string,
    {
      commands?: string[][];
      fixtures?: { name: string; bundle: string; revision: string }[];
    }
  >;
}
export function prepareCase(
  sandbox: Sandbox,
  id: string,
  profile?: Preparation,
): void {
  const preparation = profile?.cases[id];
  for (const fixture of preparation?.fixtures ?? []) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(fixture.name) ||
      !/^[a-f0-9]{40}$/.test(fixture.revision)
    )
      throw new Error(
        'Fixture needs a simple sibling name and a pinned full revision.',
      );
    const target = join(dirname(sandbox.repo), fixture.name);
    if (target === sandbox.repo || existsSync(target))
      throw new Error('Fixture target already exists.');
    for (const cmd of [
      ['git', 'clone', '--quiet', '--no-checkout', fixture.bundle, target],
      [
        'git',
        '-C',
        target,
        'checkout',
        '--quiet',
        '--detach',
        fixture.revision,
      ],
    ]) {
      const r = exec(cmd, { cwd: sandbox.repo, env: sandbox.env });
      if (r.code) throw new Error(`Fixture preparation failed: ${r.stderr}`);
    }
  }
  for (const command of preparation?.commands ?? []) {
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((x) => typeof x !== 'string' || !x)
    )
      throw new Error('Preparation commands must be nonempty argv arrays.');
    const r = exec(command, { cwd: sandbox.repo, env: sandbox.env });
    if (r.code)
      throw new Error(
        `Preparation failed (${command[0]}): ${r.stderr.slice(-2000)}`,
      );
  }
  if (git(['diff', '--name-only', 'HEAD'], sandbox.repo))
    throw new Error('Preparation changed tracked case content.');
}

interface Input {
  hash: string;
  identity: RuntimeIdentity;
  runtimeName: string;
}
interface Manifest {
  schema: 'prbench.comparison/v1';
  id: string;
  identity: string;
  split: string;
  baseline: Input;
  candidate: Input;
  cases: { id: string; hash: string }[];
  harness: string;
  harnessRevision: string;
  bunVersion: string;
  agentCommandHash: string;
  preparationHash: string;
  cliVersion: string;
  frozenPreparationHash?: string;
  settings: {
    models: string[];
    judges: string[];
    effort: string;
    timeoutMs: number;
    promptHash: string;
    rubricVersion: number;
  };
}
export interface CompareOptions {
  baselineSkill: string;
  candidateSkill: string;
  cases: string;
  split: string;
  out: string;
  resume?: boolean;
  preparation?: string;
  prepareOnly?: boolean;
  development?: string;
}
export function assertResume(expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error(
      'Experiment inputs changed; use a new output directory rather than reusing artifacts.',
    );
}

/** Operational diagnostics are separate from the description quality score. */
export function operationSummary(metrics: Record<string, any>[]) {
  const median = (values: unknown[]) => {
    const numbers = values
      .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
      .sort((a, b) => a - b);
    return numbers.length
      ? (numbers[Math.floor((numbers.length - 1) / 2)]! +
          numbers[Math.floor(numbers.length / 2)]!) /
          2
      : null;
  };
  const groups = new Map<string, Record<string, any>[]>();
  const stages = (items: Record<string, any>[]) => {
    const entries = items.flatMap((i) => i.toolTimings ?? []) as {
      stage: string;
      durationMs: number;
    }[];
    return Object.fromEntries(
      [...new Set(entries.map((e) => e.stage))].sort().map((stage) => {
        const values = entries
          .filter((e) => e.stage === stage)
          .map((e) => e.durationMs);
        return [
          stage,
          {
            records: values.length,
            totalMs: values.reduce((a, b) => a + b, 0),
            medianMs: median(values),
          },
        ];
      }),
    );
  };
  for (const item of metrics) {
    const key = `${item.model}/${item.system}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map((items) => ({
    model: items[0]!.model as string,
    system: items[0]!.system as string,
    cases: items.length,
    writerMedianMs: median(items.map((i) => i.stageTimings?.writerMs)),
    authWaitMedianMs: median(items.map((i) => i.stageTimings?.authWaitMs)),
    inputTokenMedian: median(items.map((i) => i.inputTokens)),
    outputTokenMedian: median(items.map((i) => i.outputTokens)),
    writerErrors: items.filter((i) => i.writerOutcome?.isError).length,
    pendingCleanup: items.filter((i) => i.cleanup === 'pending').length,
    toolTimingCases: items.filter((i) => i.toolTimings?.length).length,
    toolTimingGapCases: items.filter((i) => i.toolTimingGaps?.length).length,
    toolStages: stages(items),
  }));
}

export async function compare(opts: CompareOptions): Promise<void> {
  if (!['dev', 'test'].includes(opts.split))
    throw new Error('Comparison split must be dev or test.');
  const root = resolve(opts.out),
    harnessRoot = resolve(import.meta.dir, '..');
  const runtimeName = `tracetoon-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
  const inputs = [opts.baselineSkill, opts.candidateSkill].map((s) => {
    const skill = resolve(s),
      runtime = join(skill, 'bin', runtimeName);
    return {
      hash: directoryDigest(skill),
      identity: runtimeIdentity(skill, runtime),
      runtimeName,
    };
  });
  if (opts.split === 'test') {
    if (!opts.development)
      throw new Error(
        'Held-out comparison requires --development <completed dev experiment>.',
      );
    const dev = json<Manifest>(join(opts.development, 'manifest.json'));
    if (
      dev.split !== 'dev' ||
      !json(join(opts.development, 'summary.json')).qualityGate.passed
    )
      throw new Error(
        'Development quality gate must pass before held-out evaluation.',
      );
    assertResume([dev.baseline, dev.candidate], inputs);
  }
  const selected = caseDirs(resolve(opts.cases))
    .map(loadCase)
    .filter((l) => l.case.split === opts.split && !l.case.excluded);
  if (!selected.length) throw new Error('No eligible comparison cases.');
  if (selected.some((l) => !l.case.repo.bundle))
    throw new Error(
      'Frozen comparisons require self-contained case Git bundles.',
    );
  if (selected.some((l) => !codexSystem(false).supports(l).supported))
    throw new Error('Comparison contains an unsupported case.');
  const preparation: Preparation | undefined = opts.preparation
    ? json(resolve(opts.preparation))
    : undefined;
  if (
    preparation &&
    (!preparation.cases || typeof preparation.cases !== 'object')
  )
    throw new Error('Preparation profile needs a cases object.');
  const fixtures = Object.values(preparation?.cases ?? {}).flatMap(
    (p) => p.fixtures ?? [],
  );
  const preparationHash = hash(
    JSON.stringify([
      preparation ?? null,
      fixtures.map((f) =>
        hash(readFileSync(resolve(dirname(opts.preparation!), f.bundle))),
      ),
    ]),
  );
  const cli = exec([...codexCommand(), '--version']);
  if (cli.code) throw new Error('Codex CLI unavailable.');
  const harness = hash(
    JSON.stringify([
      directoryDigest(join(harnessRoot, 'src')),
      ...['bun.lock', 'package.json', 'tsconfig.json'].map((f) =>
        readFileSync(join(harnessRoot, f), 'utf8'),
      ),
      Bun.version,
      git(['rev-parse', 'HEAD'], harnessRoot),
    ]),
  );
  if (opts.split === 'test')
    assertResume(
      json<Manifest>(join(opts.development!, 'manifest.json')).harness,
      harness,
    );
  const stable = {
    schema: 'prbench.comparison/v1' as const,
    split: opts.split,
    baseline: inputs[0]!,
    candidate: inputs[1]!,
    cases: selected.map((l) => ({
      id: l.case.id,
      hash: directoryDigest(l.dir),
    })),
    harness,
    harnessRevision: git(['rev-parse', 'HEAD'], harnessRoot),
    bunVersion: Bun.version,
    agentCommandHash: hash(JSON.stringify(codexCommand())),
    preparationHash,
    cliVersion: cli.stdout.trim(),
    settings: {
      models: MODELS,
      judges: JUDGES,
      effort: 'medium',
      timeoutMs: 30 * 60_000,
      promptHash: hash(PR_PROMPT),
      rubricVersion: RUBRIC_VERSION,
    },
  };
  const identity = hash(JSON.stringify(stable));
  let manifest: Manifest;
  if (existsSync(join(root, 'manifest.json'))) {
    if (!opts.resume)
      throw new Error(
        'Experiment exists; use --resume or another output directory.',
      );
    manifest = json(join(root, 'manifest.json'));
    assertResume(manifest.identity, identity);
  } else {
    if (existsSync(root) && readdirSync(root).length)
      throw new Error('New experiment output must be empty.');
    manifest = { ...stable, id: identity, identity };
    mkdirSync(join(root, 'inputs', 'cases'), { recursive: true });
    for (const [i, name] of ['baseline', 'candidate'].entries())
      cpSync(
        resolve(i ? opts.candidateSkill : opts.baselineSkill),
        join(root, 'inputs', name),
        { recursive: true },
      );
    for (const l of selected)
      cpSync(l.dir, join(root, 'inputs', 'cases', l.case.id), {
        recursive: true,
      });
    if (preparation) {
      const frozen = structuredClone(preparation);
      for (const entry of Object.values(frozen.cases))
        for (const f of entry.fixtures ?? []) {
          const source = resolve(dirname(opts.preparation!), f.bundle),
            dest = join(
              root,
              'inputs',
              'fixtures',
              hash(readFileSync(source)) + '.bundle',
            );
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(source, dest);
          f.bundle = dest;
        }
      save(join(root, 'inputs', 'preparation.json'), frozen);
      manifest.frozenPreparationHash = hash(
        readFileSync(join(root, 'inputs', 'preparation.json')),
      );
    }
    save(join(root, 'manifest.json'), manifest);
  }
  for (const name of ['baseline', 'candidate'] as const)
    assertResume(
      manifest[name].hash,
      directoryDigest(join(root, 'inputs', name)),
    );
  for (const c of manifest.cases)
    assertResume(c.hash, directoryDigest(join(root, 'inputs', 'cases', c.id)));
  if (opts.prepareOnly) {
    console.log(`Frozen experiment: ${join(root, 'manifest.json')}`);
    return;
  }
  const frozenPreparation = existsSync(join(root, 'inputs', 'preparation.json'))
    ? json<Preparation>(join(root, 'inputs', 'preparation.json'))
    : undefined;
  if (manifest.frozenPreparationHash) {
    assertResume(
      manifest.frozenPreparationHash,
      hash(readFileSync(join(root, 'inputs', 'preparation.json'))),
    );
    for (const entry of Object.values(frozenPreparation!.cases))
      for (const f of entry.fixtures ?? [])
        assertResume(
          f.bundle
            .split(/[\\/]/)
            .pop()!
            .replace(/\.bundle$/, ''),
          hash(readFileSync(f.bundle)),
        );
  }
  const reports: { model: string; comparison: string; report: Report }[] = [];
  const writerMetrics: Record<string, unknown>[] = [];
  for (const [modelIndex, model] of MODELS.entries()) {
    const artifacts = new Map<string, Map<string, PRArtifact>>();
    const loaded = manifest.cases.map((c) =>
      loadCase(join(root, 'inputs', 'cases', c.id)),
    );
    for (const [caseIndex, l] of loaded.entries()) {
      const rotate = (modelIndex + caseIndex) % SYSTEMS.length;
      const order = [...SYSTEMS.slice(rotate), ...SYSTEMS.slice(0, rotate)];
      const arts = new Map<string, PRArtifact>();
      artifacts.set(l.case.id, arts);
      for (const system of order) {
        assertResume(
          manifest.cliVersion,
          exec([...codexCommand(), '--version']).stdout.trim(),
        );
        const out = join(root, model, 'artifacts'),
          file = join(out, l.case.id, `${system}.json`);
        let artifact: PRArtifact;
        const which =
          system === 'tracetoon-baseline' ? 'baseline' : 'candidate';
        const skill = join(root, 'inputs', which),
          runtime = join(skill, 'bin', manifest[which].runtimeName);
        if (existsSync(file)) {
          if (!opts.resume)
            throw new Error('Artifact already exists without --resume.');
          artifact = json(file);
          const receipt = json(join(out, l.case.id, `${system}.receipt.json`));
          assertResume(receipt, {
            experiment: manifest.id,
            digest: artifactDigest(artifact),
          });
          if (
            checkArtifact(artifact).length ||
            artifact.system !== system ||
            artifact.meta.experimentId !== manifest.id
          )
            throw new Error('Saved artifact identity is invalid.');
        } else {
          console.log(`write ${model} / ${l.case.id} / ${system}`);
          if (system !== 'codex-native')
            assertResume(
              manifest[which].identity,
              runtimeIdentity(skill, runtime),
            );
          const adapter = codexSystem(
            system !== 'codex-native',
            {
              model,
              reasoningEffort: 'medium',
              timeoutMs: manifest.settings.timeoutMs,
            },
            system === 'codex-native'
              ? undefined
              : { id: system, skill, runtime },
          );
          const result = await runCase(l, adapter, {
            outDir: out,
            prepare: (s) => prepareCase(s, l.case.id, frozenPreparation),
            log: console.error,
          });
          artifact = result.artifact;
          artifact.meta.experimentId = manifest.id;
          if (system !== 'codex-native') {
            assertResume(manifest[which].hash, directoryDigest(skill));
            artifact.meta.runtimeIdentity = manifest[which].identity;
          }
          save(file, artifact);
          save(join(out, l.case.id, `${system}.receipt.json`), {
            experiment: manifest.id,
            digest: artifactDigest(artifact),
          });
        }
        arts.set(system, artifact);
        const statusFile = join(out, l.case.id, `${system}.status.json`);
        writerMetrics.push({
          model,
          case: l.case.id,
          system,
          durationMs: artifact.meta.durationMs,
          stageTimings: artifact.meta.stageTimings,
          writerOutcome: artifact.meta.writerOutcome,
          inputTokens: artifact.meta.inputTokens,
          outputTokens: artifact.meta.outputTokens,
          toolTimings: artifact.meta.toolTimings,
          toolTimingGaps: artifact.meta.toolTimingGaps,
          cleanup: existsSync(statusFile)
            ? json(statusFile).cleanup?.state
            : 'unknown',
        });
      }
    }
    for (const baseline of ['tracetoon-baseline', 'codex-native']) {
      const results: PairResult[] = [],
        facts = new Map(),
        splitOf = new Map(),
        pairArtifacts = new Map<string, Map<string, PRArtifact>>();
      const out = join(root, model, baseline);
      for (const l of loaded) {
        const f = loadFacts(l);
        if (!f) throw new Error('Comparison case needs a judge fact sheet.');
        facts.set(l.case.id, f);
        splitOf.set(l.case.id, l.case.split);
        const arts = artifacts.get(l.case.id)!;
        pairArtifacts.set(
          l.case.id,
          new Map(
            [baseline, 'tracetoon-candidate'].map((s) => [s, arts.get(s)!]),
          ),
        );
        for (const judge of JUDGES) {
          console.log(`judge ${model} / ${l.case.id} / ${baseline} / ${judge}`);
          results.push(
            await judgePair({
              loaded: l,
              facts: f,
              x: arts.get(baseline)!,
              y: arts.get('tracetoon-candidate')!,
              judge: parseJudge(judge),
              outDir: join(out, 'judgments'),
            }),
          );
          save(join(out, 'pairs.json'), results);
        }
      }
      const report = buildReport({
        results,
        judges: JUDGES,
        artifacts: pairArtifacts,
        facts,
        splitOf,
      });
      save(join(out, 'report.json'), report);
      writeFileSync(join(out, 'report.md'), reportMarkdown(report));
      reports.push({ model, comparison: baseline, report });
    }
  }
  const baselineReports = reports.filter(
    (r) => r.comparison === 'tracetoon-baseline',
  );
  const sums = (
    system: string,
    key:
      | 'factualErrors'
      | 'unsupportedClaims'
      | 'claimCoverage'
      | 'contextCoverage',
  ) =>
    baselineReports.reduce(
      (n, r) =>
        n +
        r.report.splits[opts.split]!.systems.find((s) => s.system === system)![
          key
        ],
      0,
    );
  const failures: string[] = [];
  for (const model of MODELS) {
    const pairs = json<PairResult[]>(
      join(root, model, 'tracetoon-baseline', 'pairs.json'),
    );
    if (
      pairs.some(
        (p) =>
          p.case === 'pr8' &&
          p.sides['tracetoon-candidate']?.some(
            (s) => s.unsupportedClaims.length,
          ),
      )
    )
      failures.push(`${model}: pr8 still has unsupported claims`);
  }
  for (const key of [
    'factualErrors',
    'unsupportedClaims',
    'claimCoverage',
    'contextCoverage',
  ] as const) {
    const b = sums('tracetoon-baseline', key),
      c = sums('tracetoon-candidate', key);
    if (key.endsWith('Coverage') ? c + 1e-9 < b : c > b + 1e-9)
      failures.push(`${key} regressed against baseline`);
  }
  const summary = {
    experiment: manifest.id,
    split: opts.split,
    qualityGate: { passed: !failures.length, failures },
    reports,
    writerMetrics,
    operations: operationSummary(writerMetrics),
    limitations: [
      'One writer sample per case/model/system; timing and judge differences are exploratory.',
      'CLI token usage is not a USD cost estimate.',
      'Partial execution observations remain unknown; preparation is not writer validation.',
    ],
  };
  save(join(root, 'summary.json'), summary);
  writeFileSync(
    join(root, 'summary.md'),
    `# ${opts.split} comparison\n\nQuality gate: ${failures.length ? failures.join('; ') : 'passed'}\n\n` +
      '| Model | System | Cases | Median writer seconds | Median auth wait seconds | Median input tokens | Writer errors | Pending cleanup |\n|---|---|---:|---:|---:|---:|---:|---:|\n' +
      summary.operations
        .map(
          (r) =>
            `| ${r.model} | ${r.system} | ${r.cases} | ${r.writerMedianMs === null ? 'unknown' : (r.writerMedianMs / 1000).toFixed(2)} | ${r.authWaitMedianMs === null ? 'unknown' : (r.authWaitMedianMs / 1000).toFixed(2)} | ${r.inputTokenMedian ?? 'unknown'} | ${r.writerErrors} | ${r.pendingCleanup} |`,
        )
        .join('\n') +
      '\n\nThese are exploratory timings with one writer sample per case/model/system. Writer time includes model-service waits and observation overhead, and excludes the separate authentication queue.\n\n' +
      '| Model | System | Runtime stage | Records | Sum of recorded ms | Median record ms |\n|---|---|---|---:|---:|---:|\n' +
      summary.operations
        .flatMap((r) =>
          Object.entries(r.toolStages).map(
            ([stage, t]) =>
              `| ${r.model} | ${r.system} | ${stage} | ${t.records} | ${t.totalMs.toFixed(2)} | ${t.medianMs?.toFixed(2) ?? 'unknown'} |`,
          ),
        )
        .join('\n') +
      '\n\nRuntime stage timers are self-reported operational diagnostics, separate from neutral check evidence. Records may overlap and are not invocation counts; do not add nested stages into a pipeline total. Missing logs and excluded records are retained in toolTimingGaps.\n\n' +
      reports
        .map(
          (r) =>
            `## ${r.model}: ${r.comparison} vs candidate\n\n${reportMarkdown(r.report)}`,
        )
        .join('\n'),
  );
  console.log(`Comparison complete: ${join(root, 'summary.json')}`);
  if (failures.length)
    throw new Error(
      `Quality gate failed: ${failures.join('; ')}. Preserve this experiment; held-out evaluation is not enabled by a failed development gate.`,
    );
}
