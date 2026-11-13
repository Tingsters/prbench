---
pretty_name: prbench real PR replay cases
language:
- en
license: apache-2.0
tags:
- software-engineering
- agent-traces
- evaluation
size_categories:
- n<1K
---

# prbench real PR replay cases, 1.0.0

Seven historical replay cases for comparing the accuracy and usefulness of AI-written pull requests. Each case contains an immutable repository bundle, time-sliced and redacted work sessions, unchanged fact sheets, and source-bound fact provenance. Six sessions are Claude Code sessions; one is Codex. No original session files are needed on the receiving machine.

## Access

Install prbench 0.3.0 or newer, then run `prbench datasets fetch real-cases@1.0.0`. Use `--out cases-local` for a project-local installation. Downloads require no account; running model evaluations requires the user's own Codex login. Bun 1.3.14+ and Git are required. VEX AIM has no package-install preparation: its simulator tests use Python's standard library. Rust/Cargo is needed only for optional CLI build checks. Hardware acceptance requires a real device and is not implied by this dataset.

`prbench compare --baseline-skill <built-dir> --candidate-skill <built-dir> --out results/comparison --prepare-only` uses the pinned default dataset and its preparation profile when `--cases` is omitted. It performs no model calls. Remove `--prepare-only` only when ready to run the paid/usage-limited evaluation. Baseline and candidate skills must include binaries for the recipient's platform.

## Composition and splits

| Split | Case IDs | Purpose |
| --- | --- | --- |
| dev | pr5, pr8, pr9, pr11, pr12 | Tool development and comparison |
| test | pr10, vexaim | Evaluation after the development gate |

The split was fixed before this publication and has not changed. The user authorized publication curation of test facts; no writer, judge or tuning run was performed during curation. Public test data is available for reproducibility; researchers must avoid tuning on it and then claiming untouched held-out validation. Showtail's excluded case and its transcripts are not included. A pinned Showtail source bundle is included solely as a build dependency.

## Collection and provenance

Cases come from the session owner's open-source work on Tracetoon and VEX AIM in October 2026. The owner consented to public redistribution of the redacted seven-case library. Imports retain case base/head commits, session IDs, timestamps, tool links and record order. Records that wrote published PR text were removed before slicing; the original leak check is applied without weakening it. Published PR text, when present, is a separate comparison artifact and is never a writer input.

Fact text was hand-checked in the original project and remains unchanged. The publication's per-fact source review was performed by Codex and is explicitly marked **automated**, not human adjudication. Claims reference pinned code ranges; contextual observations reference the original historical digest packet or attributed commit narratives. The historical digest is a source artifact, not an independently verified execution log or a current test receipt. It remains outside writer sandboxes and writer cache identities.

Several facts describe clipped or aggregated historical observations. These limits do not mean that an event never occurred or that newer, more complete evidence is false. Fresh accurate checks must be judged from their own evidence. Test-run counts do not establish passing checks on the exact final commit. Tracetoon and VEX AIM versions, model/provider names and behaviors in these cases describe the historical snapshots, not current product recommendations.

## Privacy and transformations

The review covered prompts, embedded file contents, commands, outputs and the added historical source packets. Credential-shaped values, personal emails, home paths, host/user/network/device identifiers were pseudonymized. Embedded image data and opaque encrypted provider payloads/signatures were removed; image block types and surrounding text were retained. No redaction map, authentication cache, raw audit backup or original agent-home directory is distributed. Public repository identities and Git author/commit metadata remain in immutable source bundles so commit SHAs stay valid.

`MANIFEST.md` records case metadata and redaction categories. The release's archive checksum is pinned in the prbench registry; `dataset.json` hashes every installed file. Download verification never executes preparation commands. Package managers may need network access when a comparison prepares a checkout.

## Intended use and limitations

Use for paired PR-writing tool comparisons on fixed evidence. Seven cases from one owner's projects are a small convenience sample, not a representative measure of general software-engineering ability. The cases include overlapping work sessions, historical extractor limits and missing direct user prompts in some slices. No new benchmark quality result or speed improvement is asserted by publishing the data. Preserve the same cases, split, model settings and preparation across compared tools.

## License, attribution and maintenance

Dataset compilation, owner-contributed text and annotations are distributed under Apache-2.0; see LICENSE. Source repositories, dependencies and third-party quoted material retain their applicable upstream terms; see NOTICE.md and licenses in the Git histories. Attribute Tracetoon/prbench and the source projects when redistributing. Do not replace assets for an existing version: corrections require a new dataset version and checksum. Report accidental disclosure through the repository's private vulnerability reporting mechanism when available, or privately to the owner; do not reproduce secrets in public issues.

The release is hosted at https://github.com/Tracetoon/prbench/releases/tag/cases-v1.0.0. The harness and dataset have independent versions. MANIFEST.md and the release metadata identify the exact inputs.
