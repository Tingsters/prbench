# Fixed completion protocol

This round finishes with a supported verdict. It does not automatically retune a
candidate or add samples after a failure or inconclusive result. Release and
local installation are conditional on passing admission, development and
held-out adoption gates. Historical v1/v5 experiments remain unchanged.

## Maintained diagnostic commands

`calibrate-scope` freezes four synthetic examples, optionally followed by the two
retained error controls and the disputed draft. Expected statuses and author
rationales are not sent to judges. Packets supply neutral source evidence,
actual description paragraphs and exact clauses to assess. Every selected clause
must appear in the structured reply. Missing clauses use the existing one-format-
repair allowance within the persisted three-attempt budget.

```powershell
bun run prbench calibrate-scope --out results/round4-calibration --historical results/round3-judge-calibration --disputed-screen results/round3-writer-screen-v2 --plan
```

Remove `--plan` to execute; use `--resume` only for identical frozen inputs.
The complete sequence has 28 order judgments and no writer calls. A scope-stage
mismatch stops before historical controls; a later mismatch stops before the
next phase. Preference flips are reported separately. Same-provider agreement
against author-reviewed expectations is not independent human calibration.

Historical error controls are targeted checks: their selected incorrect and
corrected clauses gate that phase. Incidental flags elsewhere in those old
descriptions remain in `additionalFindings`; the controls are not declared
globally error-free. Retained-dispute and admission accuracy gates inspect every
candidate flag. Flags on historical reference descriptions remain separately
visible rather than being counted as candidate defects.

`admission` requires a verified, complete passing full calibration. Its declared
cases are pr8/pr9, each with Sol and Terra at medium effort: four candidate
drafts, two unscored isolation probes and 16 order judgments. It accepts a pinned
candidate skill, preparation profile, development case root and corrected
historical controls. `--plan` launches no models; `--resume` retains exact
compatible generations and judgments. Admission is diagnostic and cannot serve
as a confirmation performance block.

Both commands retain immutable inputs, checksummed generation/judge caches,
accepted raw-order digests, attempt history, current state and derived report
receipts. They use owned controller/process cleanup and have no indefinite wait
for a missing writer file. Altered accepted judgments are rejected before
another model call. Source revision and full harness hash are provenance;
effective stage inputs determine cache reuse.

## Comparable validation

Command evidence may include optional canonical `check` metadata from the
collector: argv, repository-relative directory, script source hash and fresh or
receipt-reuse execution mode. Metrics never parse tool files or infer validation
from PR prose. Literal package aliases and supported shell wrappers are
normalized without executing shell text; unsupported expressions stay unknown.

Performance reports use schema `prbench.performance/v2` and report per-pair
`validationComparability` as `matched`, `unmatched` or `unknown`, with reasons.
An eligible pair has identical case code, matching completed validation targets
and flags, successful completed checks, and observations bound to final content.
A reused receipt needs an earlier captured pass on that same content. Repeated
identical checks count once for coverage while their time and token cost remain
measured. Runtime counters are not validation evidence.

Unknown or unmatched work prevents a performance pass. The report keeps all
expected pairs and descriptive timings; it does not select a favorable subset.
Legacy artifacts without canonical evidence remain readable and unknown. All
writers receive the same instruction that silence alone is not a hang and an
interrupted check is incomplete.

## Conditional execution and promotion

After calibration passes, reserve the next unused release-candidate version,
produce CI artifacts and freeze the exact native candidate and receipts. The
fixed admission screen precedes 90 development drafts/240 judgments; development
must pass before 36 held-out drafts/96 judgments or held-out source access.

The maximum scheduled quality cohort is 130 new drafts and 380 order judgments,
plus up to 14 unscored isolation probes and bounded recovery attempts. No passing
historical draft is relabeled as a fresh confirmation sample. A writer-affecting
change after freeze ends this candidate's experiment instead of starting another
candidate automatically.

Only after both confirmation gates pass: merge validated repositories, promote
the tested CI artifacts by checksum, publish the reserved release candidate and
install that exact tag locally. A last-minute rebuild is not automatically the
tested runtime. A negative or inconclusive verdict instead ends with committed
code and a report explaining the stopping gate.

Implementation verification: the full suite passed 189 tests, with one platform
skip and no failures. After final target-scoping and noncomparable-timing
clarifications, four diagnostic tests and four validation/performance tests
passed. Type checking and whitespace checks passed. The synthetic admission
test collected exactly four drafts and 16 orders, then resumed with no new
writer or judge calls. These test doubles make no live model requests.

The fixed live calibration passed all 28 orders under rubric v6, with zero
writer calls, mismatches, unresolved findings, additional findings, preference
flips, retries, format repairs or pending cleanup. The checksummed report is
experiment `d4fb1a66404a8ad44036b79a67f913efbdb6dd8cd9f4c37d5a42c0481b6e3062`
(source revision `4159ca2d1d35aeb98f246e11ba0a0e65ada69628`). Its 16 synthetic
scope orders, eight retained error-control orders and four retained-dispute
orders all passed their declared expectations. This supports proceeding to
admission; it does not establish candidate quality or performance. Historical v5
judgments remain unchanged. Private cases and raw model outputs stay ignored.

## Completed round-four verdict

The fixed admission screen finished **inconclusive** (exit 3): four new candidate
drafts, 16 accepted order judgments and two passing isolation probes. No writer
or judge invocation was added beyond the declared screen. All four artifacts
met the three-role/current-v2-review and completed-validation coverage checks;
there were no workflow/evidence gaps or pending cleanup. These are admission
checks, not confirmation performance results.

Both judges flagged one candidate's absolute claim that an earlier evaluation
had not been rerun. In one presentation order they marked it unverifiable:
omitted executions cannot prove absence of a fresh run. In reverse order they
read it as a historical assertion contradicted by a later recorded rerun. The
report retains both interpretations, one separate reference-control finding
and one separate preference flip. It does not collapse two judges' flags on the
same claim into two independent candidate defects, rewrite a judgment or
adjudicate the ambiguity away.

The admission experiment is
`8ec7ebd53a0845a5afe4fd18593d77fd4f87209012df2103f2aa452816a0114c`;
its immutable judging stage is
`92ef651f4a2a9a8d6dd1f2a3ab77d9921497b4f4c60612788295195c3ec9c00a`
with pairs digest
`a09742e46bee376f810cb6ee4c8d28c76353ac6b5769244a2c5d1a3bc10bdb28`.

The frozen candidate was rc.24 at source `872a37d`, build
`dbdff58866721e9b52186d9ff1637a419d1212538c018244c3b6da8477699193`.
CI run [41772612043](https://github.com/Tingsters/tracetoon/actions/runs/41772612043)
passed all three platform suites, reproducibility, portable ZIP checks and a
separate rehearsal of the exact retained Windows bundle and executable.
Artifact `13295193643` has ZIP digest
`439935c9ad5da03d9730c9fcd44054ded7def2861e2c3b26409a724ea64cec3d`;
the Windows executable has SHA-256
`549e5e8dda749d54f75d6a07918fd9c7bc5a97ca4a5095b8562b396963ab104e`.
Compilation uses Ubuntu because the pinned Bun toolchain's Windows-to-Linux
cross-compilation failed; the Windows verification consumes the uploaded bytes
without rebuilding them. Archive entries retain Unix executable permissions,
and Linux/macOS CI extracts and executes the launcher.

The declared stopping rule now ends this round. Development confirmation and
held-out testing were not launched; held-out sources remain unopened. No
adoption or performance gain is established, and nothing was merged, released
or installed. Raw private evidence stays ignored and the candidate is retained.
The concrete follow-up is to scope negative validation claims to the captured
record and reconcile later historical outcomes before describing reruns. That
requires a separately authorized candidate round, not automatic retuning or
resampling of this one.

## Subsequent delivery decision

After reviewing this verdict, the user explicitly requested a new release
through a PR to main and local installation. That request authorizes shipping
the retained CI-tested rc.24 artifact despite the inconclusive admission; it
does not change the evaluation result or authorize a new benchmark round.
Tracetoon's `tracetoon.release-promotion/v2` record preserves the actual
calibration/admission report hashes and marks both confirmation stages not run.
The release continues to verify the original CI artifact, source build identity
and every payload checksum. No quality-score or performance gain is established.
