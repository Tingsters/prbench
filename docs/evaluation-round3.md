# Evaluation reliability and workflow improvements

Implementation follows the approved plan: immutable build/case inputs; stage-specific caches; durable attempts and owned process trees; Tracetoon clause review and shared preparation; targeted calibration; then one frozen, three-replicate comparison.

The previous complete development experiment remains `results/round2-dev-v10` and failed its quality gate. Its 30 drafts and 80 order judgments are historical evidence, not new confirmation samples. Earlier partial trials are diagnostics. Held-out sources stay sealed until development passes.

## Execution order

- [x] Isolate and pin Tracetoon's Showtail build input.
- [x] Implement content-addressed cache and durable operational ledger primitives.
- [x] Implement and locally test Windows owned Job Objects and POSIX process groups.
- [x] Implement selected-split corpus/source preflight.
- [x] Add shared Tracetoon preparation, batch expansion, source snapshots, and review-v2 validation.
- [x] Wire comparison-v2, report/status recovery, bounded retries, and fixed replicates.
- [x] Finish Tracetoon check/render reuse, profiling, role instructions, and regression tests.
- [x] Complete regression suites and source-backed development provenance review.
- [x] Complete the four-draft writer screen (pr8/pr9, both models), 16 order judgments, source adjudication, and candidate freezing.
- [ ] Run 90 development drafts / 240 order judgments. **Not started:** the admission screen has an unresolved scope/materiality finding.
- [ ] Only following development adoption-gate pass: run 36 held-out drafts / 96 order judgments. **Gated; held-out inputs remain unopened.**

## Completion policy

No experiment-wide deadline is imposed. Each logical call has a persisted attempt limit and configured hung-process timeout. A valid quality failure ends with a failure report; it never starts another candidate-tuning loop. Confirmation uses fresh, paired controls. Diagnostic replay may reuse exact compatible writers. Existing results, raw judge replies, failures, and cleanup history remain available.

Do not release, install, merge, push, or publish as part of this work.

## Verified implementation

The final broad prbench run passed **178 tests**, with one platform skip and no
failures (179 tests across 23 files). It covers adoption policy, current independent
review requirements, fresh-validation source proofs and report-only recovery.
Tracetoon's source run passed 33 of 34 files; the remaining file's
two real-Git tests exceeded Bun's default five-second limit, then passed with an
explicit fixture timeout. All 12 bundle contracts and all three native contracts
passed. Build reproduction produced identical outputs from two independent
snapshots on the Windows/Bun 1.3.14 host.

Candidate build: `dfe3104054c92bff83c8aca93f39a0e260728b3ecbcc3e636e5edcf642fbf6bd`.
Its native SHA-256 is `fbcb349678ad2c7ed6df8b3d53a28d8ace8991340c9c5b7cdc26cfb9fc67d89f`.
No release or local installation was performed.

The new development snapshot has 112 source-referenced facts across five cases.
Corrections preserve observed historical passes, distinguish tests from commands
that stopped before testing, scope earlier plans, and retain the no-repository-edit
fallback in pr8. A missing primary request stays missing; plan text and secondary
tool reports retain their attribution. Historical inputs and v10 results remain
unchanged. Real facts, transcripts, provenance ledgers and results remain ignored.

The fixed judge calibration completed eight order judgments. Both judges caught
both targeted historical errors in both orders (8/8), with no flags against the
corrected target clauses. It also flagged a possible pr9 scope issue about
explicitly selected, unapproved providers, only in BA order; materiality and
position sensitivity need separate calibration. These are targeted
checks, not broad semantic reliability or candidate-quality measurements.

## Candidate result: inconclusive admission screen

All four drafts and all 16 order judgments completed. The Sol/pr8 draft says
“Turn-end timing now uses repo edits” without preserving the no-repository-edit
fallback. Both judges flagged this clause in both orders. The immutable source
at head `c973ef3a079f41d81e7efcdc610d09ff05bc2eba`,
`src/correlate/correlate.ts:299`, uses `(edits.length ? edits : turn)`.

The retained independent review explicitly considered this branch at checkpoint
B3.5, cited code lines 280–311, and treated it as unchanged supporting detail:
“Existing fallback remains; the body describes the changed edit selection.” The
judges instead read the sentence as an unqualified timing claim. The source
establishes the branch, but does not settle that scope/materiality disagreement.
Adjudication is therefore **unresolved**, with zero confirmed factual errors and
one unresolved finding. The earlier confirmed label and report are preserved in
the local history. No draft or raw judgment changed.

The other three drafts received no accuracy flags in this targeted screen.
Every draft recorded three distinct role declarations and a current v2 review.
These structural checks did not settle the remaining semantic scope disagreement.
No candidate retuning or accepted-quality resampling followed the failure.

The judge screen required one format-only repair for duplicate claim assessments;
the invalid response and repair remain preserved. All accepted order bytes passed
their stored digest checks. Current pending writer cleanup is zero.

Two Terra samples interrupted fresh test runs. Their shorter writer times do not
establish equivalent-work efficiency. There are no fresh paired controls or
three-replicate confirmation data, so no aggregate quality or performance gain is
claimed. The 90-draft confirmation and held-out round were not launched.

Local evidence: `results/round3-judge-calibration/summary.json` and
`results/round3-writer-screen-judgments/summary.md`, with raw outputs and separate
source adjudication beside them. The immutable pilot retains its original writer
contract. Collector integrity was tightened afterward and tested without
regenerating the pilot: title, head, guidance, digest and source changes invalidate
a current-review declaration. Fresh-validation adjudication proofs bind an actual
command to the flagged artifact, and recording-summary references cannot serve as
passing-test proof.

Remaining quality work needs human calibration of when a changed-path summary
must explicitly preserve an unchanged fallback. The reviewer already had and
cited the source; more context alone would not resolve this disagreement. Use a
source-backed boundary example to test the sentence's scope, and keep this draft
as a disagreement case. Any clearer candidate wording belongs to a new round.
Also investigate interrupted historical-fixture tests before drawing efficiency
conclusions from their writer timings.

## Restart audit and recovery

The historical comparison-v1 cache identity included all harness source and Git
HEAD. The v6, v7 and v8 manifests have identical baseline, candidate, cases and
settings, but different harness fingerprints. Those audit repairs needlessly
invalidated generation reuse. Their retained artifact counts are 11, 8 and 15;
the later completed v10 has 30 drafts. These are historical samples, not a fresh
confirmation block.

Comparison-v2 already separates writer, judge and report inputs. A follow-up
audit found that its saved scope-failure marker still demanded a new experiment,
and completed generations were only cached after scope acceptance. Recovery now
caches a successful, structurally valid generation before auditing, then checks
the same immutable output on resume. Current audit receipts bind the artifact
digest to the scope-checker contract; original rejections and immutable audit
decisions remain available. Genuine violations still stop the comparison.

Regression coverage exercises cache recovery with no accepted artifact/receipt,
a retained obsolete rejection, zero new synthetic writer/judge calls, and a real
violation that remains rejected on repeated resume. A test against the actual
writer dependency closure verifies that scope, report, judge and Git-only edits
retain its identity while writer-prompt edits invalidate it. This follow-up used
no live model calls and did not restart any benchmark. Legacy v1 drafts are not
automatically certified for v2 confirmation.

Follow-up validation: `bun run test` passed 181 tests with one platform skip and
zero failures (182 tests across 23 files); `bun run typecheck` and
`git diff --check` passed. The local test log is
`node_modules/.cache/eval-scope-recovery-regression.log`.

After the broad regression run, nine targeted runner tests passed, including two
new cases proving that a failed initial status write still cleans its sandbox and
that a later persistence error cannot mask the primary writer failure.
