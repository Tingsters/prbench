export const COMPARISON_SYSTEMS = [
  "codex-native",
  "tracetoon-baseline",
  "tracetoon-candidate",
];
/** Three repeats put every system in every position for each case/model. */
export function systemOrder(
  modelIndex: number,
  caseIndex: number,
  replicate: number,
  systems: string[] = COMPARISON_SYSTEMS,
) {
  if (!Number.isSafeInteger(replicate) || replicate < 1)
    throw new Error("Replicate IDs start at one.");
  const rotate = (modelIndex + caseIndex + replicate - 1) % systems.length;
  return [...systems.slice(rotate), ...systems.slice(0, rotate)];
}
