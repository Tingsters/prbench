import { original } from './original.ts';
import type { System } from './types.ts';

// Adapters for agents' native PR flows and for PR tools (e.g. tracetoon) are
// added here as they are built.
export const SYSTEMS: System[] = [original];

export function findSystem(id: string): System {
  const s = SYSTEMS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown system "${id}" (known: ${SYSTEMS.map((x) => x.id).join(', ')})`);
  return s;
}
