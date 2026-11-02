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
import { runCodex } from '../agents/codex.ts';
import { loadCase } from '../schema/case.ts';
import {
  installTracetoon,
  type PinnedTracetoon,
} from '../systems/tracetoon.ts';
import { cleanupOwned, ownSandbox } from './cleanup.ts';
import { createSandbox } from './sandbox.ts';

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

export async function verifyComparisonIsolation(options: {
  root: string;
  experiment: string;
  probeCase: string;
  models: string[];
  variants: { system: string; pinned?: PinnedTracetoon }[];
}) {
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
  const probes: unknown[] = [];
  for (const model of options.models)
    for (const variant of options.variants) {
      console.log(`isolation ${model} / ${variant.system}`);
    const sandbox = createSandbox(loadCase(options.probeCase));
      const owner = ownSandbox(sandbox.root);
      try {
        const installed = variant.pinned
          ? installTracetoon(sandbox, 'codex', variant.pinned)
          : undefined;
        const existing = new Set(traces(join(sandbox.codexHome, 'sessions')));
        const run = await runCodex(sandbox, {
          prompt: ISOLATION_PROMPT,
          model,
          reasoningEffort: 'medium',
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
        probes.push({
          model,
          system: variant.system,
          passed: true,
          catalogue,
          reported: run.result,
          stageTimings: run.stageTimings,
        });
      } catch (error) {
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
    }
  const text =
    JSON.stringify({ experiment: options.experiment, probes }, null, 2) + '\n';
  writeFileSync(file, text);
  writeFileSync(
    receipt,
    JSON.stringify({ experiment: options.experiment, digest: digest(text) }),
  );
}
