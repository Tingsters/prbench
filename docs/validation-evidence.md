# Validation evidence and rubric v3

A writer can run checks while preparing a PR, after the original work sessions ended. Rubric v2 supplied judges only the original sessions and required those sessions to establish claimed passes. Consequently, some historical `unsupportedClaims` describe a judge evidence gap. Those counts must not be described as fabrication rates, or used to conclude that writers should omit accurate fresh results.

## Capture contract

`PRArtifact.validation` is an optional, provider-neutral `prbench.validation/v1` record. The artifact remains `prbench.artifact/v1` so legacy artifacts can be loaded; an absent validation field means unavailable evidence. Metrics consume this field and never inspect Tracetoon receipts or another system's private files.

Both provider runners use the same capture module. Codex command-execution events and Claude streaming tool-use/results supply execution evidence. Claude uses `--output-format stream-json --verbose`; final result accounting remains separate. The collector also reads newly created or appended session logs, including nested sessions, before sandbox disposal. It excludes the original copied session bytes, rewritten original files and persisted events outside the actual writer-run time window. Unreadable, malformed, untimed or oversized fresh traces become explicit gaps. Final model messages and self-reviews cannot create a command record.

Each execution retains a neutral source reference, command, cwd, available start/completion times, exit code when explicitly recorded, outcome, bounded redacted output and a digest of the redacted output stream. Long-running shell calls are joined to later poll results. Tool completion with no numeric exit code remains distinct from exit zero; neither an agent turn completion nor a wrapper exit proves that the described suite passed. Failures, incomplete executions, timeouts and truncation remain visible. Capture is limited to 500 executions, 24,000 output characters per execution and 32 MiB per persisted trace; omissions are recorded. Future adapters must supply the same evidence contract.

The harness observes content at live execution start/result ingestion and after the writer exits. Fingerprints include tracked and non-ignored untracked file bytes, deletions, symlinks and executable bits. They exclude ignored dependencies, external files and submodule contents. Fingerprinting can be unavailable for unreadable or large trees. These are observations at stream ingestion, not an atomic attestation of what a running process read. Different boundary fingerprints identify stale/changed content. Missing observations mean unknown tested content; a final HEAD alone never proves which bytes were tested. Identical observed content supports a narrower conclusion than validation in every environment.

Coverage is `recorded` when the observed execution records have no known capture gaps, `partial` when gaps exist, and `unavailable` when no fresh executions were captured. This describes observability, not whether tests passed, whether the agent ran every useful check, or whether a shell command's own output is truthful. A command that only echoes a passing summary is evidence of that echo, not of test execution.

Known environment secret values, recognizable credentials and user paths are redacted before retention. Fresh packets replace writer tool/provider identifiers while preserving commands, failures and result facts. Raw provider streams are not archived by this change. Redacted bounded execution records survive in the local artifact; full omitted output is unavailable. Real artifacts, audits and logs remain private under ignored result directories and require the existing consent/redaction process before sharing.

## Judge contract

The packet distinguishes shared original work-session evidence from description A's and B's fresh evidence. The latter follows its description when the pair order reverses. Fact-sheet statements about validation are scoped to the original work: an earlier failure or missing original test run can coexist with a later fresh pass. If a writer changed the proposed code, each side receives its own diff. Fact sheets remain unavailable to writers.

Judges assess every validation claim and disputed claim using four statuses:

| Status | Meaning | Aggregate treatment |
|---|---|---|
| `supported` | Positive evidence establishes the claim at its stated scope | Verified claim assessment |
| `contradicted` | Specific evidence conflicts at the relevant time, content and environment | `factualErrors` |
| `unsupported` | A scope overclaim, such as a universal guarantee from a narrow check | `unsupportedClaims` |
| `unverifiable` | Missing, partial or truncated evidence prevents assessment | Separate evidence-gap count |

Each assessment records the exact claim, reason and evidence references. Supported, contradicted and unsupported assessments require references. The validator rejects nonexistent, omitted and opposite-side fresh references, error lists that do not match assessments, and inconsistent abstentions. Reference allow-lists come from structured evidence, never from headings a writer could insert into PR text or command output. A contradiction establishes an error, not intent; no fabrication rate is inferred.

Do not count missing receipts as factual errors or unsupported overclaims, credit missing results as verified, or demand deletion of accurate validation statements. Assess other available content normally; an evidence gap does not automatically force a tie. If preference depends on resolving the gap, the judge returns `inconclusive` with `preferenceDependsOnMissingEvidence=true`. Either order abstaining makes the pair inconclusive. Consensus retains an abstention from any configured judge. Inconclusive comparisons are counted explicitly and excluded from wins, ties, sign tests, bootstrap means/intervals and judge agreement. Null rubric scores denote items that cannot be assessed.

Reports show evidence-gap counts separately from factual errors and overclaims, plus per-system artifact coverage. They retain incomplete judge coverage separately. Rubric v3 prompt hashes include a digest of the whole fresh evidence bundle, even when some records are omitted from the excerpt, and the explicit version; order caches live under `judgments/v3/`. Generated pair results also bind each artifact's digest: rebuilding a report with changed drafts or evidence requires rejudging. External result imports without those digests receive an explicit provenance warning. Report generation rejects legacy/mixed result versions, and judging refuses to overwrite a directory containing historical reports/plans/results. Preserve v2 reports as historical and use a new output directory for v3.

## Auditing historical runs

Audit a development cohort without calling a writer/judge or executing checks:

```sh
bun run prbench audit-evidence --cases cases-local --split dev --artifacts results-old/artifacts --judgments results-old/judgments --out results-evidence-audit
```

The new directory contains `audit.json`, `audit.md` and artifact copies with identical title/body. Source artifact and draft digests make preservation reviewable. Historical findings keep their original verdict and are listed for reassessment; a validation-keyword flag is only a screening heuristic. The audit reads case metadata for split selection and defaults to development cases. It does not use held-out outcomes to tune the rubric.

If authentic logs survived, supply `--recovery-manifest manifest.local.json` with explicit mappings:

```json
{
  "schema": "prbench.recovery/v1",
  "entries": [{
    "case": "case-id",
    "system": "system-id",
    "artifactSha256": "sha256-of-original-artifact-file",
    "repoPath": "/original/writer/sandbox/work/repo",
    "sessions": [{"file": "writer-session.jsonl", "sha256": "sha256-of-session-file"}]
  }]
}
```

Session paths are relative to the manifest or absolute. Recovery verifies source hashes, repository context and event times within the artifact's recorded start/duration. Association relies on this explicit mapping; hashes establish file identity, not independent proof of authenticity. Recovered records have unknown execution-time content unless it was captured originally; this implementation never reconstructs it from a current checkout. Failed mappings stop the audit before output is written. Missing logs remain unavailable. Do not substitute a PR's prose, a tool's self-review or checks run today for historical execution evidence.

Where recovered evidence supports reassessment, rejudge the same copied drafts with the normal `judge` command, pointing `--artifacts` to the audit's `artifacts/` and `--out` to a separate v3 results directory. That command calls configured model judges. Keep old and new reports separate and review changed findings, remaining gaps and position flips. Without recovered logs, an audit cannot resolve historical fresh-check claims or produce corrected fabrication/error rates. A new writer benchmark would be a separate cohort, not a reconstruction of the old executions.

## Verification and remaining calibration

Synthetic tests cover true fresh passes absent from original sessions, fresh failures, changed/unknown content, missing receipts, incomplete and canceled commands, output truncation, polling, copied-log exclusion, redaction, reference spoofing, both A/B orders, cache invalidation, report abstention/coverage, and recovery provenance. Provider fixtures execute actual case tests through both native and tool flows and verify evidence survives into artifacts. These verify the evaluator's plumbing and constraints; they do not establish a real judge's semantic reliability. Human and cross-family calibration remain necessary under the methodology's development/held-out protocol.
