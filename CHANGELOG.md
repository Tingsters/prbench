# Changelog

## 0.2.0

- Capture fresh writer command evidence for Claude and Codex in both native and tool flows, retaining results and explicit provenance limits before sandbox cleanup.
- Supply original work-session evidence and each writer's fresh validation evidence separately to blind judges.
- Introduce rubric v3 claim assessments: supported, contradicted, unsupported scope overclaim, and unverifiable due to missing evidence. Evidence-dependent preferences are reported as inconclusive.
- Preserve substantive validation statements during attribution normalization.
- Bind judging caches and report rebuilds to evidence, and keep incompatible historical results separate.
- Add `audit-evidence` for immutable historical draft copies and explicit, hash-checked recovery mappings. Missing historical execution records remain unavailable; old unsupported counts are not fabrication rates.
- Add `prbench --version` and a Bun-installable source release including replay helpers.

Historical rubric v2 reports are preserved. Use a new output directory for v3 judging. Human and cross-family judge calibration remain necessary; synthetic tests verify evidence handling and do not establish real judges' semantic accuracy.
