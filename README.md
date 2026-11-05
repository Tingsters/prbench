# prbench

### Public case library

The real replay cases are available as a versioned download, with redacted sessions,
repository bundles, fact provenance and pinned setup dependencies. No original
agent logs or checkout on the author's machine are needed.

```sh
bun install --global https://github.com/Tingsters/prbench/releases/download/v0.3.0/prbench-0.3.0.tgz
prbench datasets list
prbench datasets fetch real-cases@1.0.0
prbench preflight --dataset real-cases@1.0.0
```

`compare` uses this pinned dataset and its preparation profile when `--cases` is
omitted. Supply your built baseline/candidate skills and add `--prepare-only`
for a smoke test with no model calls. See [download and run instructions](docs/datasets.md)
and the [dataset card](datasets/DATASET_CARD.md) for splits, privacy, license and limits.

### Frozen comparisons

`bun run prbench compare --baseline-skill <dir> --candidate-skill <dir> --cases <dir> --split dev --out results/<experiment>`
compares native Codex, baseline Tracetoon and candidate Tracetoon using Sol and
Terra at medium, the same two judges in both presentation orders, and a 30-minute
writer timeout. Each skill must include its matching platform binary in `bin/`.
Comics and connected apps are disabled. Existing single-system commands remain available.

#### Providers and parallel runs

`--provider` picks who writes and who judges. A comparison never mixes the two
families:

| `--provider`      | Writers                                                                                     | Judges                           | Login                                                                |
| ----------------- | ------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `codex` (default) | `codex-native`, baseline and candidate Tracetoon on Sol and Terra                           | Sol and Terra                    | `prbench auth codex`                                                 |
| `claude`          | `claude-native`, baseline and candidate Tracetoon on Claude Opus and Sonnet (effort medium) | Opus and Sonnet                  | `claude setup-token`, then pipe the token into `prbench auth claude` |
| `both`            | two independent runs, in `<out>/codex` and `<out>/claude`                                   | each provider judges its own run | both                                                                 |

A provider judging drafts from its own models is an accepted limitation; the two
runs are reported separately, never pooled. A test-split run must use the
provider of its development run (`--development` points at the same layout).

`--parallel <n>` (default 4) runs up to n writers, judges and isolation probes
at once per provider. Judges start as soon as the two drafts they compare exist,
so finished cases report early. `--parallel 1` keeps the serial order. The
frozen inputs, cache keys and reports do not depend on the setting. Concurrent
Codex runs share the dedicated login file through a link instead of copying it,
so refreshed tokens are never overwritten (verified with codex-cli 0.164 under
concurrent forced refreshes); Windows keeps the exclusive copy mode. Claude runs
use a long-lived setup token and need no coordination. After a failure no new
job starts, running jobs finish and are saved, and `--resume` continues.

The command freezes skill/runtime bytes and case inputs, records harness and CLI
identity, rotates system execution order, and serializes credential use. It
compares candidate against baseline and native separately. `--prepare-only`
freezes without calling a model; `--resume` accepts only matching inputs and
hash-verified saved artifacts. Changed inputs require a new output directory.
Reports and private execution status stay in the ignored experiment directory.

Before scoring, six short unscored probes (each model and system) verify the
actual startup skill catalogue and require zero tool calls. Native must see no
Tracetoon skill; each tool arm must see exactly its repository-local frozen copy.
The probes use the synthetic example, never held-out content. `--verify-only`
stops after this check. Hash-verified isolation receipts are reused on resume.
Codex runs suppress host skill discovery and remote plugins and explicitly
disable global Tracetoon entries. These CLI feature flags are version-specific;
an unavailable flag or an unrecognized catalogue fails before draft collection.
Every writer receives the same workspace-scope instructions. After collection,
the comparison audits its neutral command records for observable host agent
configuration/skill reads, host ancestor instructions and outside case inputs.
A violation retains the artifact for diagnosis and rejects the comparison before
judging or issuing its reuse receipt. This complements catalogue probes; neither
the prompt nor the audit turns the workspace into a filesystem security boundary.

`--preparation <file>` accepts an explicit JSON profile with a `cases` object.
Each case may have `commands` (nonempty argv arrays, run in the checkout) and
`fixtures` (`name`, local Git `bundle`, full `revision`), materialized as siblings.
Bundle paths are relative to the profile. Preparation is identical across systems,
must leave tracked content unchanged, and is recorded separately from writer checks.

For held-out cases use `--split test --development <passing-dev-experiment>`.
The baseline, candidate and harness must match the completed development run.
The quality gate compares factual errors, unsupported claims and claim/context
coverage against baseline; development pr8 must have no unsupported candidate claims.
Do not tune on held-out findings and then present another run as untouched validation.

Timing metadata distinguishes installation, authentication waiting, writer
execution, collection and setup; status files separately record cleanup and total
time. Legacy `durationMs` retains its existing meaning. Token counts are CLI
usage, not dollar estimates. The adapter retains invocation-owned internal
Tracetoon stage timers before cleanup and reports their counts, totals and
medians alongside the neutral pipeline timings. Invalid or unavailable logs
remain explicit gaps. Runtime timers are diagnostics, not validation evidence.
Records may overlap and are not invocation counts; nested stages must not be
added into a pipeline total. Use the neutral writer clock for elapsed execution.
When Codex omits an execution directory, the collector can correlate an exact
command and time window with explicit, statically resolved tool arguments in
that writer's own rollout. An omitted `workdir` uses only the recorded turn
context's default directory. It records this as `cwdSource`; ambiguous matches,
dynamic code and other sessions remain unknown. Transcript code is never executed.
This does not strengthen boundary fingerprints into atomic test attestations.

Judges can retain a completed JSON stream reply when the CLI omits its output
file. The same schema and evidence-reference checks still apply. Transport and
format failures share a bounded three-attempt budget, including at most one
format-correction request; saved judgments remain
available for an exact-input resume after an unrecoverable failure.
Execution content observations remain partial when
the tool stream does not establish them; preparation never proves writer validation.

A saved draft survives cleanup failure. Retry only owned pending sandboxes with
`bun run prbench cleanup --experiment <dir>`. Ownership tokens, roots and parents
are checked before deletion; symlinks and unrelated processes are not followed.

An evaluation harness for tools that write or change the pull requests produced by AI coding agents.

It answers: **does this PR tool produce better pull requests than the agent would have without it?** It runs each system on the same fixed cases, collects the PR each one would have opened, and scores those PRs for accuracy and usefulness to a reviewer.

> **Status: milestone 1.** Five systems (`original`, `claude-native`, `tracetoon`, `codex-native`, `codex-tracetoon`), blind pairwise judging and reports. A dedicated accuracy checker and human calibration come next; see the [roadmap](docs/methodology.md#roadmap).

## Why

No existing benchmark scores the whole PR (title, description, commits and whether the text matches the diff) or compares a PR tool against a baseline. Research shows description–diff mismatch is the strongest sign of a bad agent PR, and that word-overlap metrics like BLEU and ROUGE track human judgment poorly. See [docs/related-work.md](docs/related-work.md).

## Quick start

Needs [Bun](https://bun.sh) 1.3.14 or later and git.

Install the released CLI globally with Bun:

```sh
bun install --global https://github.com/Tingsters/prbench/releases/download/v0.3.0/prbench-0.3.0.tgz
prbench --version
prbench --help
```

The release is a source package that includes the replay helpers. Bun remains required at runtime. Cases and result paths are relative to your working directory unless explicitly supplied. For development, use the repository commands below.

```sh
bun install
bun run prbench validate                 # check every case under cases/
bun run prbench systems                  # list systems
bun run prbench run -s original          # write results/artifacts/<case>/original.json
bun run prbench check-artifact results/artifacts/example-greet-default/original.json
bun run test
bun run typecheck
```

`run --keep-sandbox` leaves the sandbox on disk so you can inspect it.

## Comparing PR tools

```sh
bun run scripts/import-tracetoon-cases.ts            # real cases -> cases-local/ (git-ignored)
bun run prbench run -s original      --cases cases-local
bun run prbench run -s claude-native --cases cases-local --split dev
bun run prbench run -s tracetoon     --cases cases-local --split dev
bun run prbench judge --cases cases-local             # both orders, judges: claude and codex
# -> results/report.md, results/report.json, results/judgments/
```

- **Claude systems need their own login.** Sandboxes have their own home directory, so run `claude setup-token` and save the token to `~/.prbench/claude-oauth-token`, or set `PRBENCH_CLAUDE_OAUTH_TOKEN`. An `ANTHROPIC_API_KEY` also works.
- **Model and cost for Claude.** `--model` (default `opus`) and `--max-budget-usd` (default 25 per run) apply to both Claude systems.
- **Judges** use `claude` with tools/hooks off or ephemeral, read-only `codex exec`. Choose them with `--judges claude:opus,codex`; dedicated Codex login and effort settings are described below.
- **Caching.** Judgments are cached by prompt, so re-running `judge` only pays for new or changed pairs. `prbench report` rebuilds the report from `results/pairs.json` and the saved judging configuration. Missing judgments are listed explicitly and excluded from judge consensus.

## Sol and Terra through Codex

Run `bun run prbench auth codex` in your terminal and complete the browser sign-in. This creates a separate OAuth cache at `~/.prbench/codex-auth`; `--status` checks it and `--device-auth` selects device-code login. `PRBENCH_CODEX_AUTH_HOME` can choose another dedicated cache. Keep it outside the repository and never paste its contents into chat. See [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth).

Each Codex process receives a temporary copy of that dedicated cache, then returns any refreshed credentials and removes the copy. Access is serialized across writers and explicit-effort judges so refreshes cannot race. Interrupted controllers leave a lock with their PID; if a stale-lock error reports that the controller exited, remove that lock file before retrying. Do not sign in again while a benchmark owns the cache. The interactive Codex login is never copied.

After an explicit Codex turn-completion event, the runner allows two seconds for CLI cleanup, then stops cleanup that remains alive. Artifacts record that intervention. This keeps a completed preview's background process from holding the login lock indefinitely; normal process exits retain their actual exit status.

Use separate directories per model and effort. Run these for Sol, then repeat with `gpt-6.1-terra` and `results-codex-terra`:

```sh
bun run prbench run -s codex-native --model gpt-6.1-sol --reasoning-effort medium --cases cases-local --split dev --timeout-min 30 --skip-existing -o results-codex-sol/artifacts
bun run prbench run -s codex-tracetoon --model gpt-6.1-sol --reasoning-effort medium --cases cases-local --split dev --timeout-min 30 --skip-existing -o results-codex-sol/artifacts
bun run prbench judge --systems codex-native,codex-tracetoon --judges codex:gpt-6.1-sol@medium,codex:gpt-6.1-terra@medium --cases cases-local --split dev --artifacts results-codex-sol/artifacts -o results-codex-sol -j 1
```

Both Codex flows receive the same `PR_PROMPT`, model, reasoning effort, permissions and timeout. `--skip-existing` rejects Codex artifacts with different model/effort settings. Codex defaults to `gpt-6.1-sol` at `medium`; `PRBENCH_CODEX_MODEL` and `PRBENCH_CODEX_REASONING_EFFORT` override those defaults. Codex CLI has no USD spending-cap flag and reports no dollar cost, so these runs use no USD cap; an explicit dollar cap is rejected. OAuth runs exclude inherited API keys. Tracetoon comics are off in benchmark sandboxes. On Windows the harness compiles and caches a fake `gh.exe` under `node_modules/.cache/prbench-gh`, so executable discovery also stays inside the sandbox.

The `@effort` judge syntax uses the dedicated cache, an isolated home and explicit model/effort. It disables hooks, delegation, shell, image and plugin tools. Connected apps, browser use and computer use are disabled for Codex writers and these judges; PR calls go through the fake `gh`. Judge IDs include effort, keeping those cached judgments separate. Legacy `codex[:model]` judges retain their existing login/configuration behavior. Sol and Terra are two models from the same provider; agreement between them does not replace cross-family or human calibration. Claude artifacts and judgments can stay in their existing directories.

## How it fits together

Rubric v5 retains the v4 evidence separation and adds independent clause, fallback, and review-location audits. It supplies original work-session evidence and each writer's fresh command evidence separately. Capture-summary references `A.V0` and `B.V0` make recording limits citable; they cannot establish that a check passed, failed or did not run. Missing check receipts remain evidence gaps; contradictions and scope overclaims have separate findings. Evidence-dependent preferences are inconclusive, and reports show evidence coverage. Preserve historical v2/v3 results. Legacy v2 unsupported counts may include missing fresh evidence and must not be interpreted as fabrication rates. See [validation evidence and historical audits](docs/validation-evidence.md).

Rubric v6 makes scope findings depend on the breadth actually asserted in context and a reachable, source-backed counterexample. It separates an omitted unchanged fallback from an incorrect universal guarantee. See [scope calibration](docs/scope-calibration.md) for the policy, fixed synthetic examples, and current calibration limits. Historical v5 results remain unchanged.

To prepare existing development drafts for reassessment while preserving their originals:

```sh
bun run prbench audit-evidence --cases cases-local --split dev --artifacts results-old/artifacts --judgments results-old/judgments --out results-evidence-audit
```

This local audit calls no models and never reruns historical checks. Use a new output directory when judging under v5; historical reports and caches are preserved.

- A **case** (`cases/<id>/`) fixes the starting point: a repo snapshot, the task and, for replay cases, the recorded agent sessions and resulting commits. [docs/cases.md](docs/cases.md)
- A **system** (`src/systems/`) turns a case into a **PR artifact** (`src/schema/artifact.ts`). Systems run in a **sandbox** (`src/run/sandbox.ts`) with their own home directory holding only the case's sessions, a fake `gh` that captures PRs, and a local remote for pushes.
- **Metrics** only see artifacts, so any PR tool can be compared with any other. [docs/methodology.md](docs/methodology.md)

## Adding a system

Implement `System` from `src/systems/types.ts` and register it in `src/systems/index.ts`. A system gets the loaded case (without its fact sheet) and a sandbox, runs whatever it needs with `sandbox.env` inside `sandbox.repo`, and returns a `PRArtifact`. PRs opened through `gh pr create` are available from `sandbox.capturedPRs()`. Use the provider's shared runner (`runClaude` or `runCodex`) and `PR_PROMPT` so each tool flow differs from its native baseline only in what it installs.

## License

Apache-2.0

## Reproducible comparisons (v2)

`compare` defaults to the predeclared confirmation protocol: three samples per case/model/system, Sol and Terra at medium effort, two independent judges, and both orders. A selected real case needs `facts-provenance.json` before writers start; source references bind each fact to immutable code or session records. Facts and published descriptions are excluded from writer cache identities and never copied to writer sandboxes.

```sh
bun run prbench preflight --cases <dir> --split dev --out results/preflight.json
bun run prbench compare --baseline-skill <dir> --candidate-skill <dir> --cases <dir> --out results/<experiment> --plan
bun run prbench compare --baseline-skill <dir> --candidate-skill <dir> --cases <dir> --out results/<experiment> --replicates 3
bun run prbench status --experiment results/<experiment>
```

Use `--resume` with the same frozen inputs to retain completed work, or `--report-only --resume` to refresh reports without model calls. `--purpose diagnostic --replicates 1` permits compatible cross-experiment writer reuse; diagnostic results never pass the adoption gate. Confirmation creates a fresh paired performance block. Stage cache reuse is explained by `--plan`; `--cache <dir>` selects its content-addressed store. Git revision is provenance, while effective stage inputs control reuse. Legacy comparison-v1 directories are read-only.

After a fact-sheet or judge repair, `--reuse-from <inactive-dev-experiment>` retains its writer performance block only when writer inputs, controls, preparation, sampling and adoption policy still match. It does not turn diagnostic samples into confirmation samples. A stale experiment lock can be recovered with `--resume --recover-lock`; recovery verifies the experiment owner and requires that its recorded process has exited. It never terminates a process by PID.

The maintained `calibrate-scope` and `admission` commands support fixed diagnostic stages with `--plan` and exact-input `--resume`. Performance report v2 requires comparable completed validation from captured artifact evidence; faster interrupted or unknown-work samples cannot establish a performance pass. See the [fixed completion protocol](docs/completion-round4.md) for call counts, recovery and promotion rules.

Completed writer generations are cached before scope acceptance. After a scope-checker repair, `--resume` re-audits the same retained generation without another writer call. The original rejection remains in `.isolation-failure.json`; `.scope-audit.json` records the current decision, artifact digest and checker contract, with immutable decisions under `.scope-audits/`. A real scope violation still stops the comparison. Historical v1 drafts lack these recovery receipts and are not automatically promoted into a confirmation block.

The experiment retains the harness source and build receipts with its frozen inputs. Confirmation candidates require protocol-2 dependency/compiler provenance and a matching native-output receipt. Implementation and executable identities are checked before new calls. Derived report versions remain under `derived-reports/`; refreshing the latest report preserves previous views and raw judgments.

There is no total experiment deadline. Calls have a recorded timeout and at most three persisted provider attempts, including at most one format-correction request. Valid scores are never retried for a better result. Redacted private traces and attempt responses are retained before owned sandboxes are removed. Windows Job Objects and POSIX process groups limit teardown to the invocation. Shared rotating OAuth credentials remain serialized.

Quality, efficiency, and operational status are separate. Accuracy flags from any order appear in `accuracy-findings.json`; adjudications live separately and require matching source hashes and ranges. Unresolved flags remain inconclusive. Performance uses fresh paired samples and case-clustered intervals; repeats are not additional independent cases. Token usage is not a USD estimate. Read [the implementation and evaluation record](docs/evaluation-round3.md).

Exit codes: 0 completed/passed; 1 completed/failed gate; 2 incomplete or invalid; 3 completed/inconclusive; 130 cancelled. A valid failure finishes with a report. Held-out input preflight runs only after a matching development adoption gate passes.
