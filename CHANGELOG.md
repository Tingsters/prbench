# Changelog

## Unreleased

- Run comparisons end to end on Codex or Claude (`compare --provider codex|claude|both`) as one parallel job graph (`--parallel <n>`). `--models` chooses the writer models (optionally `model@effort`) and keeps the provider's judges.
- Add `compare --systems baseline,candidate` to skip native writers and judge only candidate vs baseline. A subset of systems is part of the experiment identity.
- Add `prbench score <runs…>`: absolute per-draft scores (coverage, rubric, factual errors, unsupported claims, traps) on a documented 0–100 composite, with case-clustered bootstrap intervals, paired and per-case deltas, leave-one-case-out ranges, an accuracy view, and writer and judge reliability tables. It works on existing runs.
- Price Codex writers across every thread, subagents included, at each model's own rate (`meta.usageByModel`, `src/report/prices.json`). Claude records per-model usage from `modelUsage`. Older runs are re-priced from their saved traces.
- Retry writers that time out, leave no draft, or have their draft rejected by the scope audit (up to 3 attempts, reported per arm). Writer output is cached only after it passes the scope audit.
- Retry timed-out and transient judge calls with backoff. Judge reference fields are constrained by a per-prompt schema, so a judge cannot cite IDs that a side lacks; an invalid judgment still gets one correction request before it counts as a failure.
- Make concurrent controllers safe. Preflight mirrors are cloned beside their final path and renamed into place, and ref-lock fetch conflicts are retried. Parallel Codex runs share the dedicated login through a symlink, and an exclusive-copy run joins the shared link while another controller holds it, so it never writes a stale token back.
- Set timeouts through the environment: `PRBENCH_WRITER_TIMEOUT_MS` (frozen in the experiment) and `PRBENCH_JUDGE_TIMEOUT_MS` / `--judge-timeout-ms` (may be raised on resume).
- Add `crossjudge` to judge the candidate drafts of one finished run against the baseline drafts of another, using `compare`'s consensus rule.
- Add `scripts/paired-delta.ts` to compare two runs pair by pair against their own baselines: consensus outcome counts and composite Δ-of-Δ with a case bootstrap interval.
- Add `docs/reproduce-graph-vs-base.md`, which explains how to repeat the Tracetoon graph-vs-base comparison.
- Fixes: Windows-recorded cases replay correctly on POSIX hosts. Codex command directories are recovered from rollout execution records. The fake `gh` handles `--help` and `--fill`. Shell and session bookkeeping is kept out of writers and out of environment identities. Isolation probes run at the configured effort and accept proofs saved for effort arms.

## 0.2.0

- Capture fresh writer command evidence for Claude and Codex in both native and tool flows, retaining results and explicit provenance limits before sandbox cleanup.
- Supply original work-session evidence and each writer's fresh validation evidence separately to blind judges.
- Introduce rubric v3 claim assessments: supported, contradicted, unsupported scope overclaim, and unverifiable due to missing evidence. Evidence-dependent preferences are reported as inconclusive.
- Preserve substantive validation statements during attribution normalization.
- Bind judging caches and report rebuilds to evidence, and keep incompatible historical results separate.
- Add `audit-evidence` for immutable historical draft copies and explicit, hash-checked recovery mappings. Missing historical execution records remain unavailable; old unsupported counts are not fabrication rates.
- Add `prbench --version` and a Bun-installable source release including replay helpers.

Historical rubric v2 reports are preserved. Use a new output directory for v3 judging. Human and cross-family judge calibration remain necessary; synthetic tests verify evidence handling and do not establish real judges' semantic accuracy.
