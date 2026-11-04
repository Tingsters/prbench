# Scope, fallback and omission calibration

Rubric v6 separates an incorrect claim from an optional clarification. The unit
of assessment is the exact clause in its paragraph. A generic changed-path
summary does not automatically assert that the path is universal or exclusive.
For an accuracy finding, identify the breadth actually asserted and a reachable,
source-backed counterexample at that breadth. An equally broad surrounding
paragraph can establish that scope even without words such as `always`.

An unchanged fallback need not appear in every correct changed-path summary.
Its omission can still make a description less useful; assess clarity or
consequences separately. An omitted *changed* fallback is a coverage gap unless
another assertion misdescribes it. An explicit guarantee must hold across all
relevant branches. Missing source evidence remains unknown.

The fixed synthetic examples in
`tests/fixtures/scope-calibration.ts` include:

| Example | Expected accuracy assessment | Basis |
| --- | --- | --- |
| Changed-path summary using “uses repository edits” | Supported in the stated changed-path context | Does not assert exclusivity |
| Outside activity “can no longer affect” timing | Contradicted | The no-edit fallback admits outside activity |
| Repository edits “when available, otherwise…” | Supported | Describes both branches |
| No-edit behavior with the fallback absent from the packet | Unverifiable | Missing evidence cannot establish a counterexample |

The test executes both branches, including the outside-activity counterexample.
It verifies the examples' source basis, not a language model's interpretation.
These are author-reviewed calibration expectations, not independent human gold
labels or measured judge agreement. They should be evaluated as a fixed set in
both A/B orders before claiming judge calibration; preserve every reply and stop
on disagreement rather than revising labels until a judge passes.

This policy applies to every tool. It was developed from the development-set
disagreement; it is not held-out evidence. The original four drafts, v5 judge
responses and unresolved source adjudication remain historical and unchanged.
A v6 result requires a separate output directory. Reuse retained writer drafts
for judge-only calibration; changing the rubric does not justify regenerating
writers or presenting a diagnostic screen as confirmation.
