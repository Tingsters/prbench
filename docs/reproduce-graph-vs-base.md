# Reproducing the Tracetoon graph-vs-base comparison

This page describes how to rerun the comparison between Tracetoon's original
skill and its evidence-graph skill, using the same inputs, controls and
scoring we used. Each step is a prbench command. No step depends on files that
exist only on our machines.

## What is compared

| Arm | prbench system | Skill |
|---|---|---|
| Baseline | `tracetoon-baseline` | Tracetoon's original skill (the "main skill"), built from `main` at `9ac29c4` (bundle version `1.0.0-rc.24`) |
| Candidate | `tracetoon-candidate` | The evidence-graph skill, built from the graph commit (`7483847` for the reference results below) |

Both arms run on the same writer model at the same effort, with the same
`PR_PROMPT`, budget and sandbox. They differ only in which skill is installed.
Native writers are not run (`--systems baseline,candidate`), so each case and
replicate produces one candidate draft and one baseline draft. Every judge
compares the two drafts in both orders.

## Prerequisites

- **Bun 1.3.14.** Writer environment identities include the toolchain, so
  drafts from a different Bun version are not reused from the cache.
- **Claude Code CLI and/or Codex CLI**, signed in to a separate benchmark
  login. Sandboxes get their own `HOME`, so your interactive login is never
  copied into them:
  - *Claude:* run `claude setup-token`, then pipe the token into
    `bun run src/cli.ts auth claude`. The token is stored in
    `~/.prbench/claude-oauth-token` (mode 0600; `PRBENCH_CLAUDE_TOKEN_FILE`
    moves it). `PRBENCH_CLAUDE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or
    `ANTHROPIC_API_KEY` take precedence when set. prbench reads the token only
    to pass it to sandboxed writers and judges as `CLAUDE_CODE_OAUTH_TOKEN`
    (see `src/agents/claude.ts`). `bun run src/cli.ts auth claude --status`
    reports which source it would use, by variable name or file path, and
    never prints the value.
  - *Codex:* `bun run src/cli.ts auth codex` signs in through the browser
    (`--device-auth` for headless hosts) into a dedicated login cache,
    `~/.prbench/codex-auth` (`PRBENCH_CODEX_AUTH_HOME` moves it; it must not
    be your interactive `CODEX_HOME`). Each sandbox's `auth.json` is a symlink
    to that cache, so parallel writers and judges share one login and Codex
    rotates its tokens in place (see `src/agents/codexAuth.ts`).
    `auth codex --status` checks the login without printing credentials.
- **Dataset `real-cases@1.0.0`**, dev split: `pr5 pr8 pr9 pr11 pr12`.
  `--dataset real-cases@1.0.0` downloads, verifies and caches it under
  `~/.cache/prbench/datasets/`.

## Build the two skill bundles

Each arm needs a skill directory that contains the Linux binary. Build each
bundle from a separate Tracetoon worktree:

```sh
# in a Tracetoon clone (github.com/Tingsters/tracetoon)
git worktree add /var/tmp/tt-base 9ac29c4        # baseline: main skill
git worktree add /var/tmp/tt-graph 7483847       # candidate: evidence-graph commit

for dir in /var/tmp/tt-base /var/tmp/tt-graph; do
  (cd "$dir" &&
    bun install --frozen-lockfile &&
    bun run bundle &&
    bun run build --outfile plugin/skills/tracetoon/bin/tracetoon-linux-x64)
done

mkdir -p skills
cp -r /var/tmp/tt-base/plugin/skills/tracetoon  skills/baseline
cp -r /var/tmp/tt-graph/plugin/skills/tracetoon skills/candidate
```

`skills/<arm>/build.json`, `VERSION` and
`bin/tracetoon-linux-x64.build.json` identify the build. The experiment
manifest records the bundle's version, build id and binary hash, so a rebuilt
bundle that differs in any of these makes a new experiment.

### Skill settings

The shipped evidence-graph `SKILL.md` defaults are the configuration that won
our runs, so no edits are needed:

| Setting | Default |
|---|---|
| Reviewer model | cheap: Haiku on Claude, Luna on Codex |
| Reviewer effort | xhigh |
| Review passes | 2, including lens d |
| Review findings | merged |
| Review recheck | none |
| Brief layout | toon |
| Graph search | fulltext |

Older bundles predate these defaults. For those historical runs we set the
configuration by editing these lines near the end of the bundle's `SKILL.md`,
one bundle per variant:

```text
Reviewer model: haiku.        (luna for the Codex arms)
Reviewer effort: xhigh.
Review passes: 2.
Review lenses: d.
Reviewer runner: agent.       (tracetoon for the Codex arms)
Review recheck: none.
Brief layout: toon.
Graph search: bm25.
```

Run the comparison with an unedited `SKILL.md` unless you mean to reproduce a
specific historical variant.

## Run the comparison

Run from a prbench checkout. Each command is one provider, one writer model,
5 replicates of the 5 dev cases: 50 drafts and 100 order judgments
(25 pairs × 2 judges × 2 orders).

**Claude** (Sonnet writer):

```sh
TMPDIR=/var/tmp \
PRBENCH_WRITER_TIMEOUT_MS=3600000 \
PRBENCH_JUDGE_TIMEOUT_MS=1800000 \
PRBENCH_CLAUDE_COMMAND='["/home/me/.local/share/claude/versions/2.1.319"]' \
bun run src/cli.ts compare --provider claude \
  --models claude-sonnet-5-5@medium \
  --systems baseline,candidate \
  --replicates 5 --purpose diagnostic \
  --baseline-skill skills/baseline --candidate-skill skills/candidate \
  --dataset real-cases@1.0.0 --split dev \
  --parallel 10 \
  --cache results/cache/claude \
  --out results/graph-vs-base/claude
```

**Codex** (Terra writer):

```sh
TMPDIR=/var/tmp \
PRBENCH_WRITER_TIMEOUT_MS=3600000 \
PRBENCH_JUDGE_TIMEOUT_MS=1800000 \
bun run src/cli.ts compare --provider codex \
  --models gpt-6.1-terra@medium \
  --systems baseline,candidate \
  --replicates 5 --purpose diagnostic \
  --baseline-skill skills/baseline --candidate-skill skills/candidate \
  --dataset real-cases@1.0.0 --split dev \
  --parallel 10 \
  --cache results/cache/codex \
  --out results/graph-vs-base/codex
```

Add `--plan` first to print the scheduled calls and which writer drafts the
cache will reuse, without calling any model.

**Judges** are the provider's defaults (`src/run/provider.ts`); `--models`
changes only the writers:

- Claude: `claude:claude-opus-5-5@medium` and `claude:claude-sonnet-5-5@medium`
- Codex: `codex:gpt-6.1-sol@medium` and `codex:gpt-6.1-terra@medium`

**Timeouts.** `PRBENCH_WRITER_TIMEOUT_MS` (or `--timeout-ms`) is frozen into
the experiment and the writer cache key. `PRBENCH_JUDGE_TIMEOUT_MS` (or
`--judge-timeout-ms`) is not part of any identity, so you can raise it on
`--resume`. Timed-out, no-draft and scope-rejected writers and timed-out
judges are retried up to 3 attempts and reported per arm.

### Reusing baseline drafts with `--cache`

`--cache` is a content-addressed stage cache (default
`<parent of --out>/.prbench-cache/v2`). When you compare several candidates
against the same baseline, give every run the same cache directory per
provider. The baseline drafts are then written once and reused, and only the
candidate arm calls writers. Judging still runs for every pair.

A writer draft is reused only when its whole key matches: writer contract,
case, preparation, model and effort, prompt, **CLI version**, **agent
command hash**, writer timeout, toolchain (Bun, environment and auth-profile
hashes, executable), replicate, system and the skill bundle's identity. Two
consequences:

- **Pin the CLI.** Claude Code updates itself, and a new version is a cache
  miss for every baseline draft. Point `PRBENCH_CLAUDE_COMMAND` (a JSON array)
  at a fixed version binary, for example
  `'["/home/me/.local/share/claude/versions/2.1.319"]'`, and keep the exact
  same value across runs. Changing the command path also changes the command
  hash, even when the version is the same. `PRBENCH_CODEX_COMMAND` does the
  same for Codex. Our reference runs used Claude Code 2.1.319 and
  codex-cli 0.164.0.
- Keep `PRBENCH_WRITER_TIMEOUT_MS` the same across runs that should share
  drafts.

## Score

```sh
bun run src/cli.ts score results/graph-vs-base/claude --dataset real-cases@1.0.0
bun run src/cli.ts score results/graph-vs-base/codex  --dataset real-cases@1.0.0 --json
```

`compare` also writes `summary.md` and `summary.json` in each run directory.

- **Consensus.** A pair is a consensus win for a draft only when every judge
  picks that draft in both orders. Any tie, flip or disagreement makes the
  pair a tie, and an inconclusive judgment makes it inconclusive. Reported as
  candidate W/T/L.
- **Composite (0–100), per judgment.** Coverage and rubric contribute
  `100 × (35·claims + 15·context + 15·uncertainties + 35·rubric) / 100`.
  Each term is a fraction: fact-sheet items covered, or mean rubric item / 2.
  When the rubric is missing, its weight is dropped and the rest are rescaled.
  Then subtract `15 × factual errors + 7 × unsupported claims + 10 × traps hit`,
  floored at 0 (`WEIGHTS` and `composite` in `src/report/score.ts`). A
  draft's composite is the mean over all of its judgments. An arm's composite
  is the mean of per-case means, with a case bootstrap 95% interval.
- **Cost** is the writer's reported USD (Claude). For Codex, cost is estimated
  from tokens across all threads, priced per model with
  `src/report/prices.json`.

To judge drafts from two different runs against each other directly, for
example a candidate from one run against a baseline from another, use
`crossjudge`. The two runs must share judges, rubric, judge contract, split,
cases and replicates:

```sh
bun run src/cli.ts crossjudge --candidate <runA> --baseline <runB> --out <dir> [--plan] [--parallel 10]
```

## Paired analysis across runs

To compare two candidates that were each run against the same cached
baseline, use `scripts/paired-delta.ts`. It pairs the runs by case and
replicate:

```sh
bun run scripts/paired-delta.ts <runA> <runB> --dataset real-cases@1.0.0 [--json]
```

For each (case, replicate) the script computes each run's consensus outcome
against its own baseline: +1 when all four judgments prefer the candidate,
−1 when all four prefer the baseline, 0 otherwise. It then reports:

- how many pairs A did better, B did better, or the two were equal;
- the composite Δ-of-Δ, (A cand − A base) − (B cand − B base), with a
  5000-resample case bootstrap 95% interval (seed 7);
- mean factual errors per judgment for all four arms;
- a per-case Δ-of-Δ table.

The script reads judgments with the harness's own loaders
(`collectDraftScores`, `agreedResults`), so its numbers match `score`.

## Expected cost and time

| | Claude (Sonnet writer) | Codex (Terra writer) |
|---|---|---|
| Judging, per 25-pair arm (100 judgments) | ≈ $40 (Opus + Sonnet) | reported $0 (subscription) |
| Writer, per draft | ≈ $0.43 graph vs $0.69–0.78 baseline | ≈ $0.19 graph vs $0.32 baseline (estimated) |
| Wall time at `--parallel 10` | ~30–40 min | ~30–40 min |

When baseline drafts come from the cache, only the 25 candidate drafts are
new writer calls.

## Reference results

Graph vs base, Tracetoon `7483847`, dev split, 5 replicates (25 pairs per
provider):

| Provider / writer | Candidate | Baseline | Δ composite [95% CI] | Consensus W–L | Writer cost cand. vs base |
|---|---|---|---|---|---|
| Claude / Sonnet 5.5 @ medium | 76.2 | 74.2 | +2.0 [−2.3, 6.2] | 16–1 | $0.430 vs $0.690 |
| Codex / Terra @ medium | 86.6 | 81.9 | +4.8 [3.8, 5.7] | 14–0 | $0.193 vs $0.320 |

Earlier published round, Tracetoon `96686e9`:

| Provider / writer | Candidate | Baseline | Consensus W–L |
|---|---|---|---|
| Claude / Sonnet 5.5 @ medium | 78.9 | 73.6 | 10–0 |
| Codex / Terra @ medium | 84.3 | 81.8 | 7–2 |

Judges are stochastic, so a rerun will not match these numbers exactly.
Expect the same direction, with consensus and composite intervals of similar
width.

## Release confirmation run

Tracetoon `bd55f75` (graph on Relate `aa0f79e`, Relate BM25 fulltext search links, shipped
defaults left unmodified in SKILL.md). Harness prbench-score with this branch. Claude Code
pinned to 2.1.319 (`PRBENCH_CLAUDE_COMMAND`), Codex CLI 0.164. Dataset real-cases@1.0.0, dev
split, 5 cases × 5 replicates, `--parallel 10`.

| Provider | Graph vs base composite | Δ [95% CI] | Consensus W–L | Factual errors (graph / base) | Writer cost per draft (graph / base) |
|---|---|---|---|---|---|
| Claude, Sonnet 5.5 + Haiku reviewers | 78.9 vs 73.7 | +5.2 [2.5, 8.0] | 18–1 | 0.08 / 0.09 | $0.407 / $0.690 |
| Codex, Terra 6.1 + Luna reviewers | 86.6 vs 83.2 | +3.5 [1.8, 5.1] | 12–1 | 0.00 / 0.07 | $0.207 / $0.320 |
| Codex rerun (same build) | 87.5 vs 82.3 | +5.2 [2.9, 6.8] | 13–2 | 0.00 / 0.04 | $0.198 / $0.320 |

Paired against the reference run (tracetoon `7483847`) with `scripts/paired-delta.ts`:
Claude 4 better / 2 worse / 19 equal, Δ-of-Δ +3.2 [+1.2, +5.7]; Codex 5 / 8 / 12,
Δ-of-Δ −1.3 [−2.2, −0.3], and the Codex rerun 6 / 8 / 11, +0.5 [−1.1, +1.8]. The two
Codex runs differ by about 1.8 points, which is the run-to-run noise to expect at 25 pairs.
