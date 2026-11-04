/** Synthetic, author-reviewed boundary examples; never a measured judge result. */
export type Event = { at: number; repoEdit: boolean };
export const beforeEnd = (events: Event[]) =>
  Math.max(...events.map((e) => e.at));
export const afterEnd = (events: Event[]) => {
  const edits = events.filter((e) => e.repoEdit);
  return Math.max(...(edits.length ? edits : events).map((e) => e.at));
};
export const mixedTurn: Event[] = [
  { at: 10, repoEdit: true },
  { at: 20, repoEdit: false },
];
export const fallbackTurn: Event[] = [{ at: 20, repoEdit: false }];

export const scopeCalibration = [
  {
    id: "changed-path-summary",
    context:
      "This paragraph describes the new repository-edit selection path; it does not assert that fallback behavior was removed.",
    claim: "Turn-end timing now uses repository edits.",
    expected: "supported",
    rationale:
      "The changed path uses repository edits. The word uses does not by itself assert always or only. A qualifier can improve clarity.",
  },
  {
    id: "universal-exclusion",
    context:
      "This paragraph promises that activity outside the repository never affects turn timing.",
    claim: "Outside-repository activity can no longer affect turn-end timing.",
    expected: "contradicted",
    rationale:
      "With no repository edits, the unchanged fallback uses the timestamps of all events, including outside-repository activity.",
  },
  {
    id: "qualified-fallback",
    context:
      "This paragraph describes the selection rule and its unchanged fallback.",
    claim:
      "Turn-end timing uses repository edits when available, otherwise timestamps from all turn records.",
    expected: "supported",
    rationale: "Both reachable branches are described at their actual scope.",
  },
  {
    id: "missing-fallback-evidence",
    context:
      "The packet shows that repository edits are selected, but the no-edit branch is omitted and no other source supplies it.",
    claim: "Turns with no repository edits are discarded.",
    expected: "unverifiable",
    rationale:
      "The supplied packet does not establish the fallback. Neither a pass nor a counterexample may be invented.",
  },
] as const;
