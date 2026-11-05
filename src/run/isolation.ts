/** Unscored checks of the actual startup skill catalogue, before collecting drafts. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { runClaude } from '../agents/claude.ts';
import { reasoningEffort, runCodex } from '../agents/codex.ts';
import { loadCase } from '../schema/case.ts';
import {
  installTracetoon,
  type PinnedTracetoon,
} from '../systems/tracetoon.ts';
import { cleanupOwned, ownSandbox } from './cleanup.ts';
import { createSandbox, type Sandbox } from './sandbox.ts';

export const ISOLATION_PROMPT =
  'Without running any tools, print the absolute path of the Tracetoon SKILL.md from your available-skills catalog. If no Tracetoon skill is available, print NONE. Print only that path or NONE.';
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const canonical = (path: string) => {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const traces = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? traces(join(dir, e.name))
          : e.isFile() && e.name.endsWith('.jsonl')
            ? [join(dir, e.name)]
            : [],
      );

export function inspectSkillCatalogue(texts: string[]) {
  const paths: string[] = [];
  let catalogues = 0,
    toolCalls = 0;
  for (const text of texts)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line),
        p = event.payload;
      if (event.type !== 'response_item') continue;
      if (['function_call', 'custom_tool_call', 'tool_use'].includes(p?.type))
        toolCalls++;
      if (
        p?.type !== 'message' ||
        !['developer', 'user', 'system'].includes(p.role)
      )
        continue;
      for (const content of p.content ?? []) {
        const message = content.text;
        if (
          typeof message !== 'string' ||
          !message.includes('### Available skills')
        )
          continue;
        catalogues++;
        const roots = new Map(
          [...message.matchAll(/^- `([^`]+)` = `([^`]+)`/gm)].map((m) => [
            m[1]!,
            m[2]!,
          ]),
        );
        for (const match of message.matchAll(
          /^- tracetoon:.*\(file: ([^)]+)\)/gm,
        )) {
          const raw = match[1]!,
            slash = raw.indexOf('/'),
            root = roots.get(raw.slice(0, slash));
          paths.push(root ? `${root}/${raw.slice(slash + 1)}` : raw);
        }
      }
    }
  return { catalogues, toolCalls, paths };
}

export function assertSkillIsolation(
  observed: ReturnType<typeof inspectSkillCatalogue>,
  reported: string,
  expected?: string,
) {
  if (!observed.catalogues || observed.toolCalls)
    throw new Error(
      'Isolation probe needs a captured startup catalogue and no tool calls.',
    );
  const wanted = expected ? [canonical(expected)] : [];
  if (
    JSON.stringify(observed.paths.map(canonical)) !== JSON.stringify(wanted) ||
    canonical(reported.trim()) !== canonical(expected ?? 'NONE')
  )
    throw new Error(
      'Tracetoon skill isolation failed: startup catalogue or reported path differs from the intended arm.',
    );
}

/**
 * Claude Code lists skills by name, without the SKILL.md path, so its probe
 * may answer with the catalogue name instead of a path.
 */
export const CLAUDE_ISOLATION_PROMPT = ISOLATION_PROMPT.replace(
  ' If no Tracetoon skill is available',
  ' If the catalog lists the Tracetoon skill without a path, print its skill name exactly as listed instead. If no Tracetoon skill is available',
).replace(
  'Print only that path or NONE.',
  'Print only that path, name, or NONE.',
);

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((v) =>
        typeof v === 'string'
          ? [v]
          : v && typeof v === 'object' && typeof (v as any).name === 'string'
            ? [(v as any).name as string]
            : [],
      )
    : [];

/**
 * The startup catalogue Claude Code reports in its stream-json `system`/`init`
 * event. Skills are listed by name; a bare `tracetoon` resolves to every
 * on-disk location Claude Code loads user and project skills from, so a
 * second copy shows up as a second path. Plugin-provided copies never match a
 * sandbox path.
 */
export function inspectClaudeCatalogue(
  init: Record<string, unknown> | undefined,
  toolCalls: number,
  locations: { home: string; repo: string },
) {
  const skills = names(init?.skills),
    slashCommands = names(init?.slash_commands),
    mcpServers = names(init?.mcp_servers);
  const plugins = Array.isArray(init?.plugins)
    ? (init!.plugins as unknown[]).map((p) =>
        typeof p === 'string'
          ? { name: p }
          : {
              name: String((p as any)?.name ?? ''),
              ...(typeof (p as any)?.path === 'string'
                ? { path: (p as any).path as string }
                : {}),
            },
      )
    : [];
  const paths: string[] = [];
  const isTracetoon = (name: string) =>
    name.split(':').at(-1)!.toLowerCase() === 'tracetoon';
  const skillPaths = new Map<string, string>();
  if (Array.isArray(init?.skills))
    for (const s of init!.skills as any[])
      if (
        s &&
        typeof s === 'object' &&
        typeof s.name === 'string' &&
        typeof s.path === 'string'
      )
        skillPaths.set(s.name, s.path);
  for (const name of new Set(
    [...skills, ...slashCommands].filter(isTracetoon),
  )) {
    const listed = skillPaths.get(name);
    if (listed)
      paths.push(
        listed.endsWith('SKILL.md') ? listed : join(listed, 'SKILL.md'),
      );
    else if (name.includes(':')) paths.push(`plugin:${name}`);
    else {
      const found = [locations.home, locations.repo]
        .map((root) => join(root, '.claude', 'skills', name, 'SKILL.md'))
        .filter((file) => existsSync(file));
      paths.push(...(found.length ? found : [`unresolved:${name}`]));
    }
  }
  for (const plugin of plugins)
    if (plugin.name.toLowerCase().includes('tracetoon'))
      paths.push(`plugin:${plugin.path ?? plugin.name}`);
  return {
    catalogues: init ? 1 : 0,
    toolCalls,
    paths,
    skills,
    slashCommands,
    plugins,
    mcpServers,
  };
}

/** Maps the forms Claude Code may answer with onto the intended path, so assertSkillIsolation compares like with like. */
export function normalizeClaudeReport(
  reported: string,
  home: string,
  expected?: string,
): string {
  const text = reported
    .trim()
    .replace(/^[`'"]+|[`'".]+$/g, '')
    .trim();
  const expanded = text.replace(/^(?:~|\$HOME)(?=[\\/])/, home);
  if (
    expected &&
    (expanded === 'tracetoon' || canonical(expanded) === canonical(expected))
  )
    return expected;
  return expanded;
}

async function runProbes<T>(
  count: number,
  concurrency: number,
  probe: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0,
    failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < count) {
      const index = next++;
      try {
        results[index] = await probe(index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, worker),
  );
  if (failure) throw failure.error;
  return results;
}

export async function verifyComparisonIsolation(options: {
  root: string;
  experiment: string;
  probeCase: string;
  models: string[];
  variants: { system: string; pinned?: PinnedTracetoon }[];
  /** Which agent CLI the arms run on; defaults to codex. */
  agent?: 'codex' | 'claude';
  /** Reasoning effort (codex, default medium) or Claude Code --effort (default: CLI default). */
  effort?: string;
  /** Probes to run at once; the saved order is always model x variant. */
  concurrency?: number;
}) {
  const agent = options.agent ?? 'codex';
  const file = join(options.root, 'isolation.json'),
    receipt = join(options.root, 'isolation.receipt.json');
  const expectedKeys = options.models.flatMap((model) =>
    options.variants.map((v) => `${model}/${v.system}`),
  );
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8'),
      saved = JSON.parse(text);
    const proof = JSON.parse(readFileSync(receipt, 'utf8'));
    if (
      saved.experiment !== options.experiment ||
      proof.experiment !== options.experiment ||
      proof.digest !== digest(text) ||
      JSON.stringify(saved.probes.map((p: any) => `${p.model}/${p.system}`)) !==
        JSON.stringify(expectedKeys) ||
      !saved.probes.every((p: any) => p.passed)
    )
      throw new Error('Saved isolation proof does not match this experiment.');
    return;
  }
  const jobs = options.models.flatMap((model) =>
    options.variants.map((variant) => ({ model, variant })),
  );
  let failed = false;
  const probes = await runProbes(
    jobs.length,
    options.concurrency ?? 1,
    async (index) => {
      const { model, variant } = jobs[index]!;
      console.log(`isolation ${model} / ${variant.system}`);
      const sandbox = createSandbox(loadCase(options.probeCase));
      const owner = ownSandbox(sandbox.root);
      try {
        return agent === 'claude'
          ? await probeClaude(sandbox, model, variant, options.effort)
          : await probeCodex(sandbox, model, variant, options.effort);
      } catch (error) {
        if (!failed) {
          failed = true;
          writeFileSync(
            join(options.root, 'isolation-failure.json'),
            JSON.stringify(
              {
                experiment: options.experiment,
                model,
                system: variant.system,
                error: String(error),
              },
              null,
              2,
            ),
          );
        }
        throw error;
      } finally {
        try {
          cleanupOwned(owner);
        } catch (error) {
          const status = join(
            options.root,
            'isolation-cleanup',
            `${model}-${variant.system}.status.json`,
          );
          mkdirSync(dirname(status), { recursive: true });
          writeFileSync(
            status,
            JSON.stringify(
              { cleanup: { state: 'pending', owner, error: String(error) } },
              null,
              2,
            ),
          );
          throw new Error(`Isolation sandbox cleanup pending: ${status}`);
        }
      }
    },
  );
  const text =
    JSON.stringify({ experiment: options.experiment, probes }, null, 2) + '\n';
  writeFileSync(file, text);
  writeFileSync(
    receipt,
    JSON.stringify({ experiment: options.experiment, digest: digest(text) }),
  );
}

async function probeCodex(
  sandbox: Sandbox,
  model: string,
  variant: { system: string; pinned?: PinnedTracetoon },
  effort?: string,
) {
  const installed = variant.pinned
    ? installTracetoon(sandbox, 'codex', variant.pinned)
    : undefined;
  const existing = new Set(traces(join(sandbox.codexHome, 'sessions')));
  const run = await runCodex(sandbox, {
    prompt: ISOLATION_PROMPT,
    model,
    reasoningEffort: reasoningEffort(effort ?? 'medium'),
    timeoutMs: 120_000,
    env: installed?.env ?? { TRACETOON: '0' },
    skillPath: installed?.skill,
  });
  const fresh = traces(join(sandbox.codexHome, 'sessions')).filter(
    (f) => !existing.has(f),
  );
  const catalogue = inspectSkillCatalogue(
    fresh.map((f) => readFileSync(f, 'utf8')),
  );
  if (run.isError || run.validation?.commands.length)
    throw new Error('Isolation probe failed or executed a command.');
  assertSkillIsolation(
    catalogue,
    run.result ?? '',
    installed ? join(installed.skill, 'SKILL.md') : undefined,
  );
  return {
    model,
    system: variant.system,
    passed: true,
    catalogue,
    reported: run.result,
    stageTimings: run.stageTimings,
  };
}

async function probeClaude(
  sandbox: Sandbox,
  model: string,
  variant: { system: string; pinned?: PinnedTracetoon },
  effort?: string,
) {
  const installed = variant.pinned
    ? installTracetoon(sandbox, 'claude-code', variant.pinned)
    : undefined;
  // Only the Skill tool is offered, so the skills catalogue is in context;
  // nothing is pre-approved and dontAsk denies the rest. Any tool call fails.
  const run = await runClaude(sandbox, {
    prompt: CLAUDE_ISOLATION_PROMPT,
    model,
    effort,
    tools: 'Skill',
    allowedTools: [],
    permissionMode: 'dontAsk',
    timeoutMs: 120_000,
    env: installed?.env ?? { TRACETOON: '0' },
  });
  const catalogue = inspectClaudeCatalogue(run.init, run.toolCalls ?? 0, {
    home: sandbox.home,
    repo: sandbox.repo,
  });
  if (run.isError || run.validation?.commands.length)
    throw new Error('Isolation probe failed or executed a command.');
  if (catalogue.mcpServers.length)
    throw new Error('Isolation probe loaded MCP servers.');
  const expected = installed ? join(installed.skill, 'SKILL.md') : undefined;
  assertSkillIsolation(
    catalogue,
    normalizeClaudeReport(run.result ?? '', sandbox.home, expected),
    expected,
  );
  return {
    model,
    system: variant.system,
    passed: true,
    catalogue,
    reported: run.result,
    stageTimings: run.stageTimings,
  };
}
