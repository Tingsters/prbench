import type { AgentOptions } from './agentShared.ts';
import { claudeNative } from './claudeNative.ts';
import { original } from './original.ts';
import { tracetoonSystem } from './tracetoon.ts';
import type { System } from './types.ts';

export function systems(options: Partial<AgentOptions> = {}): System[] {
  return [original, claudeNative(options), tracetoonSystem(options)];
}

export const SYSTEMS: System[] = systems();

export function findSystem(id: string, options: Partial<AgentOptions> = {}): System {
  const s = systems(options).find((x) => x.id === id);
  if (!s) throw new Error(`unknown system "${id}" (known: ${SYSTEMS.map((x) => x.id).join(', ')})`);
  return s;
}
