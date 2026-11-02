import type { ValidationEvidence } from '../schema/validation.ts';
import { unavailableValidation } from '../schema/validation.ts';
import { redactEvidence } from '../agents/validation.ts';
import { createHash } from 'node:crypto';

/** Only execution evidence is blinded; substantive PR claims remain intact. */
function blind(s: string): string {
  return redactEvidence(s).replace(/\btracetoon(?:\.cmd)?\b/gi, '[writer-tool]')
    .replace(/\b(?:claude(?:-code)?|codex|gpt-6(?:\.1)?-(?:sol|terra))\b/gi, '[writer-agent]');
}

export function validationPacket(value: ValidationEvidence | undefined, label: 'A' | 'B', budget = 16_000): { text: string; refs: Set<string> } {
  const v = value ?? unavailableValidation('Legacy artifact: fresh writer executions were not retained.');
  const digest = createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const out = [`[${label}.V0] Capture summary and recording limits; not an execution result.`, `Coverage: ${v.coverage}. Origin: ${v.origin}. Scope: ${v.scope}.`, `Evidence bundle digest: ${digest}.`,
    'Tree fingerprints cover tracked and non-ignored untracked files; ignored dependencies and submodule contents are outside this fingerprint.',
    'Before/after fingerprints are observations at stream ingestion, not atomic execution attestations. Missing observations mean unknown tested content.'];
  if (v.finalTree) out.push(`Final content: head=${v.finalTree.head}; fingerprint=${v.finalTree.fingerprint}.`);
  for (const gap of v.gaps) out.push(`Evidence gap: ${blind(gap)}`);
  const ranked = v.commands.map((c, i) => ({ c, i, priority: /\b(test|tests|check|typecheck|tsc|lint|build|pytest|cargo)\b/i.test(c.command) ? 0 : 1 }))
    .sort((a, b) => a.priority - b.priority || a.i - b.i);
  const chosen = new Map<number, string>();
  let room = Math.max(0, budget - out.join('\n').length - 300);
  for (const { c, i } of ranked) {
    const targetsRepo = /^<repo>(?:[/\\]|$)/.test(c.cwd) && !/\b(?:cd|pushd|popd|Set-Location|sl)\s+|--(?:cwd|prefix|project)\b/i.test(c.command);
    const raw = blind(c.output);
    const clipped = raw.length > 3_000 ? raw.slice(0, 1_500) + '\n[output excerpt truncated]\n' + raw.slice(-1_500) : raw;
    const text = [`[${label}.${c.id}] ${blind(c.command)}`, `cwd=${blind(c.cwd)}; cwd source=${c.cwdSource ?? 'execution record or unreported'}; started=${c.startedAt ?? 'unknown'}; completed=${c.completedAt ?? 'unknown'}; outcome=${c.outcome}; exit=${c.exitCode ?? 'unknown'}`,
      `source=${c.source}; output digest=${c.outputSha256 ?? 'unavailable'}; output truncated=${c.truncated || raw.length > 3_000}`,
      `before=${c.before ? `${c.before.head}:${c.before.fingerprint}` : 'unknown'}; after=${c.after ? `${c.after.head}:${c.after.fingerprint}` : 'unknown'}`,
      `content relation to final=${!targetsRepo || !c.before || !c.after || !v.finalTree ? 'unknown' : c.before.fingerprint === c.after.fingerprint && c.after.fingerprint === v.finalTree.fingerprint ? 'same at observed boundaries' : 'changed; a pass does not establish the final content passed'}`,
      clipped || '(no output retained)'].join('\n');
    if (text.length > room) continue;
    chosen.set(i, text); room -= text.length;
  }
  out.push(...[...chosen].sort(([a], [b]) => a - b).map(([, text]) => text));
  if (chosen.size < v.commands.length) out.push(`Evidence gap: ${v.commands.length - chosen.size} executions omitted from this packet for length. Absence from the packet cannot establish fabrication.`);
  return { text: out.join('\n'), refs: new Set([`${label}.V0`, ...[...chosen.keys()].map((i) => `${label}.${v.commands[i]!.id}`)]) };
}

export function renderValidation(value: ValidationEvidence | undefined, label: 'A' | 'B', budget = 16_000): string {
  return validationPacket(value, label, budget).text;
}
