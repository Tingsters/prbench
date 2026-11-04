# Admission follow-up

The starting implementation was committed before this work: Tracetoon
`f11f880acfc8bf4656d04c1f5e07b65c16c4ad86`, prbench
`6236b7fdd44c28734611341cf63c3c498ecbc001`. This follow-up has not launched new
writers or model judges. The frozen candidate, original drafts, raw judgments
and unresolved adjudication remain unchanged.

## Scope scoring

Rubric v6 implements the rule in [scope calibration](scope-calibration.md):
assess the breadth actually asserted in context and require a reachable source
counterexample at that breadth. A correct changed-path summary can omit an
unchanged fallback; an explicit universal guarantee must survive that fallback.
Clarity, coverage and factual error are separate assessments.

Four fixed synthetic examples cover a generic changed-path summary, an incorrect
universal exclusion, an explicit conditional summary and missing fallback
evidence. A source test executes the changed path and the retained fallback.
These are author-reviewed expectations. Live judge agreement and independent
human calibration have not been measured, so the original admission finding
remains unresolved. Re-score existing drafts under a separately identified rubric
only after a fixed calibration check; do not regenerate writers for judge repairs.

## Interrupted fixture checks

The retained Terra traces show a writer stopping each check after it appeared
stalled. In pr8 this happened after about 67 seconds and left the check wrapper
running until it was explicitly terminated. In pr9 the outer invocation was
interrupted after about 173 seconds, while later review output reported a receipt
with 76 passing tests. Those original outcomes remain uncertain.

Both pinned development fixtures were reconstructed with their pinned Showtail
sibling and installed lockfile. Initial 45-second diagnostic probes showed tests
advancing through slow end-to-end cases. One complete, bounded local run per
fixture then finished:

| Fixture | Local result | Duration |
| --- | --- | --- |
| pr8 | 71 passed, 0 failed, exit 0 | 154.9 seconds |
| pr9 | 76 passed, 0 failed, exit 0 | 183.8 seconds |

The complete runs ran concurrently on this Windows/Bun 1.3.14 host. Their
durations are diagnostic, not benchmark timings. Some individual end-to-end tests
took 15–35 seconds. The check wrapper used synchronous piped execution and
forwarded output only after exit, hiding that progress. No underlying fixture
test defect was reproduced. Reproduction today does not retroactively prove
completion or a pass in an interrupted historical execution.

The Tracetoon CLI now uses asynchronous streamed output for `check`, retaining
the lock until completion and writing the final receipt afterward. JSON stdout
remains a final receipt; progress goes to stderr. The existing synchronous
internal API shares receipt preparation and completion logic. Raw command output
and environment values are not persisted in receipts. Matching completed passes
remain reusable; missing programs and nonzero exits remain failures.

This changes the next candidate. It does not modify the frozen screen's runtime
or allow its incomplete tests to count as completed work. Do not claim a
performance improvement by comparing those interrupted samples with complete
validation runs.

Private reproduction logs and receipts live under
`node_modules/.cache/admission-issues/`. They are not benchmark samples or
committed case/session data. No held-out inputs were opened.

## Validation

prbench's full suite passed 182 tests with one platform skip and zero failures;
type checking and whitespace checks passed. The Tracetoon workflow suite passed
all 27 tests. Both new progress tests passed against source and the rebuilt
bundle; type checking and the build-manifest check passed.

The first combined Tracetoon run exposed one incorrect assertion in the new
test: its progress marker was also present in the recorded command string, so
checking that the marker was absent from the entire receipt was invalid. The
corrected test checks that raw stdout/stderr fields are absent. Only those two
new tests were rerun; the passing workflow suite was retained.

The private investigation receipt binds the case revision, case/fixture bundle
hashes, original artifact digest and local test-log hashes. Both reconstructed
repositories retained their original tracked content and were removed through
verified sandbox ownership. Historical writer artifacts still match their
original receipts.
