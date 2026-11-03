# Methodology

prbench answers one question: **does a given PR-writing tool produce better pull requests than the agent would have produced without it?** "Better" means better for the person reviewing the PR. The design follows from the research in [related-work.md](related-work.md).

Status: milestone 1. Cases, artifacts, the sandbox, five systems (`original`, `claude-native`, `tracetoon`, `codex-native`, `codex-tracetoon`), the pairwise judge and the report exist. Accuracy checking beyond the judge, human calibration and the remaining metrics are planned; see [Roadmap](#roadmap).

## Terms

- **Case.** A fixed starting point every system receives unchanged: a repository snapshot, the task the agent was given and, for replay cases, the recorded agent sessions and the commits they produced. See [cases.md](cases.md).
- **Fact sheet.** Hand-checked facts about a case's change, written from the code and sessions only, never from a PR description: claims a good description conveys, context a reviewer wants, what the evidence doesn't establish, and plausible wrong statements ("traps"). It is the answer key, so systems never see it.
- **System.** Anything that turns a case into a PR: an agent's native "open a PR" flow, the same flow with a PR tool installed, or the PR actually published (`original`).
- **Artifact.** What a reviewer would receive: title, body, commits and diff, plus run metadata (`src/schema/artifact.ts`). Metrics only ever see artifacts, which is what keeps prbench independent of any particular tool.

## Run modes

1. **Replay (primary).** The recorded sessions and the finished change are held fixed; only the step that writes the PR varies. This isolates the tool's effect and is cheap and repeatable.
2. **End-to-end (later).** The agent solves the task from scratch with and without the tool. This catches effects on scope and commits, but the code differs between runs, so comparisons are noisier.

## Systems

| System | What runs | Where the PR text comes from |
|---|---|---|
| `original` | Nothing | The PR that was published for the case. For Tracetoon's eval cases this is the description the agent wrote at the end of its own working session, before Tracetoon existed: the **in-session AI baseline**. |
| `claude-native` | `claude -p` in a **fresh session**, no PR tool installed | The PR it opens through `gh` (captured by the fake). |
| `tracetoon` | The same `claude -p`, with Tracetoon's skill and hooks installed in the sandbox's home and comics off | Tracetoon's run folder (`title.txt`, `final-body.md`). Its flow ends at a preview awaiting approval, which never comes. |
| `codex-native` | `codex exec` in a fresh session with a clean home | PR captured through fake `gh`. |
| `codex-tracetoon` | The same Codex request, with Tracetoon's Codex skill and hooks installed, comics off | Captured PR or Tracetoon's latest draft. |

Within each provider's pair, both systems get the same request word for word (`PR_PROMPT` in `src/systems/agentShared.ts`), the same model, permissions and timeout. Claude pairs share a USD cap. Codex pairs share explicit reasoning effort and no USD cap: its CLI cannot enforce dollar limits. Neither pair changes the request to favor a tool.

**Why `claude-native` runs in a fresh session.** The fairest "standard AI PR" is the agent writing the PR at the end of the session that did the work. Resuming the recorded session isn't practical for the seed cases: they come from one 78 MB session that started in the parent directory and produced several PRs. So the native baseline sees the repository, branch and commits but not the conversation. That makes it weaker than an in-session agent; `original` covers the in-session case where a published PR exists. A resumed-session baseline is a follow-up for cases with short single-task sessions.

### Agent credentials

A sandbox has its own `HOME`, so Claude Code can't use the user's normal login there. Copying `~/.claude/.credentials.json` in would be unsafe: a token refresh inside the sandbox could sign the user out. Agent systems instead use a long-lived token from `claude setup-token`, read from `~/.prbench/claude-oauth-token` or `PRBENCH_CLAUDE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`). See `src/agents/claude.ts`.

Codex uses its own benchmark OAuth cache, created by `prbench auth codex`, separate from the interactive login. A lock serializes sandbox copies and returns refreshed credentials before deleting each copy, including on run failure. Writers and `codex:model@effort` judges use that cache and exclude API keys. The CLI's token counts are recorded without adding cached input twice; dollar cost is unknown. See `src/agents/codexAuth.ts` and `src/agents/codex.ts`.

**Permissions.** Both Claude agent systems get exactly the same tools: read, search, write and edit files, start subagents, and run any shell command (`AGENT_TOOLS` in `src/systems/agentShared.ts`), with `--permission-mode acceptEdits`. PowerShell is off, because Claude Code's PowerShell tool fails inside sandboxes on Windows. Anything else is denied, since nobody can approve it.

Codex pairs share `approval_policy=never`, `danger-full-access`, explicit model/effort and clean user configuration. Web search, connected apps, browser use and computer use are disabled; in particular, app connections must not bypass fake `gh` or read published source PRs. Both permit the installed benchmark hooks without an interactive trust prompt. Only the tool variant installs Tracetoon's Codex skill and hooks. These are unattended runs as the user, with discovery isolation rather than an operating-system security boundary.

Trial runs showed why the shell is open. With an allow-list of commands, Tracetoon called its launcher in spellings the list didn't cover, and the repositories' checks ran their own tools. Each unlisted call needed an approval, so the run stalled. The project owner chose to allow any shell command (2026-10-31). Agents therefore run as the user. The sandbox redirects their home directory but is not a security boundary.

**Unattended.** The shared request tells both agents that nobody can answer questions and that anything the sandbox can't do should be noted, not asked about. Without that, a trial Tracetoon run stopped to ask what to do about checks it couldn't run (the sandbox has no installed dependencies).

**The git directory.** Claude Code won't let an unattended agent write under a `.git/` path, but Tracetoon keeps its run folder in the git directory. So the sandbox keeps its git directory outside the checkout, and both systems may use it.

## Sandbox

Each run gets a fresh sandbox (`src/run/sandbox.ts`):

- The repository is fetched from the case into `<root>/work/<name>`, named like the recorded checkout, with `main` and `origin/main` at the base commit and the work on a feature branch. Only those refs exist, so tools see an ordinary branch.
- `HOME`, `USERPROFILE`, `CODEX_HOME`, `APPDATA`, `LOCALAPPDATA` and the `XDG_*` directories point into the sandbox. The only agent logs there are the case's sessions.
- Paths recorded in the logs are rewritten: the repository's recorded path maps to the sandbox checkout, and its parent directory to the sandbox's `work` directory, so a session started from the parent still lines up. Local file URLs, including encoded spaces, follow the same mapping. Only whole paths are rewritten.
- A fake `gh` on `PATH` records every call and turns `gh pr create` into a captured PR. Pushes go to a local bare repo. Git may only use local repositories (`GIT_ALLOW_PROTOCOL=file`), so nothing is fetched from or pushed to the network. GitHub tokens are removed from the environment.
- Systems get the case without its `facts` field, and the fact sheet is never copied into the sandbox.

The sandbox isolates discovery; it is not a security boundary. A process that uses absolute paths can still reach the real filesystem.

## Session slices

Real sessions are long and cover more than one change. The importer (`scripts/import-tracetoon-cases.ts`) keeps only records from an hour before the base commit to ten seconds after the head commit, and drops every record that writes PR text (Tracetoon run folders, `gh pr create` or `edit`), wherever it falls. The import fails if the published title or the opening of the published body still appears in a slice. A first version used a two-minute margin, which let one case include the original session drafting that case's published description; it was caught before any results were reported.

A slice may not start with a record bigger than 64 KB: readers find a session's working directory in the first 128 KB of the file, so a huge first record hides the whole session.

Genuine user requests, typed rejection feedback and question replies remain in the
slice when they mention a preview path or PR command. Such references describe
the task and do not by themselves establish that a record authored PR text.
Synthetic notifications and ordinary tool output receive no such exception.
The published-title/body leak check still applies to every retained record,
including user input; a case with leaked answer text fails import.

## Judging

`prbench judge` compares every pair of systems on every case with artifacts and a fact sheet (`src/judge/`).

- **Blind and normalized.** Tool markers, HTML comments, comics, comic transcripts and attribution footers ("Assisted-by", "Generated with Claude Code", "Co-Authored-By") are stripped before judging, so judges compare descriptions, not branding. Judges never see a tool's own self-review.
- **Both orders.** Each pair is judged with each system in position A once. A win needs both orders to agree. If either order's preference depends on unavailable evidence, the pair is inconclusive; other disagreements are ties, and a *flip* when the orders picked opposite systems.
- **Judge selection.** The default uses two model families: `claude -p` (tools off, hooks off, no saved session) and `codex exec` (ephemeral, read-only), both from an empty temp directory with structured output. Explicit `codex:model@effort` judges use the dedicated OAuth cache and clean home, with hooks, memories and delegation disabled. Sol and Terra are same-family judges; their agreement is not independent cross-family validation. A pair's result is reported per judge and as "all judges agree". That combined result includes only pairs completed by every configured judge. Missing judgments are listed separately, never counted as ties or agreement. Reports show completed versus expected case/pair/judge results, including cases where every judge failed.
- **What a judge sees.** The fact sheet, commits and diff, plus a neutral excerpt of original work sessions (`src/judge/evidence.ts`). Rubric v4 supplies each writer's fresh command evidence from its artifact, separately labeled and swapped with the corresponding description. `A.V0` and `B.V0` cite capture scope and recording limits, never a test outcome. Historical validation uncertainties are time-scoped; a fresh check can establish a later result. Missing or truncated evidence is explicit. Writers never see fact sheets, and metrics never read tool-specific files. See [validation evidence](validation-evidence.md) for capture, content observations and recovery limits.
- **What a judge returns** (`src/judge/rubric.ts`, rubric v4): cited claim assessments (supported, contradicted, unsupported scope overclaim, or unverifiable due to an evidence gap); separate factual-error and overclaim lists; fact-sheet coverage; uncertainties respected; traps hit; and 0–2 scores on ten reviewer-usefulness items. Missing evidence neither proves fabrication nor verifies a claim. Accurate validation results must be preserved. Preferences include an explicit evidence-dependent abstention. Accuracy comes first, then usefulness, then the reader's effort; length is not a virtue.
- **Caching.** Judgments live under `results/judgments/v4/`, keyed by the full prompt including fresh evidence and rubric version. `results/judging.json` records rubric version, judges, cases and systems. Report generation rejects legacy/mixed results, and judging requires a new output directory when historical results exist. Preserve v2/v3 reports: v2 unsupported counts can include missing fresh execution evidence and are not fabrication rates.
- **Statistics** (`src/stats.ts`): win counts, win rate, an exact two-sided sign test, a 95% bootstrap interval on the mean per-case result, and Cohen's kappa between judges. Evidence-dependent inconclusive comparisons are counted separately and excluded from win/tie statistics and agreement. Reports also show per-system evidence-gap means and artifact evidence coverage, including artifacts awaiting judgments. Dev and test splits are reported separately.

A sanity check run on case `pr12` (the published PR against an identical copy) came out a tie for both judges in both orders.

The neutral session excerpt retains paired structured questions and answers from
Claude and Codex, including typed asynchronous user replies. These are labeled
as recorded Q&A and prioritized with user requests; arbitrary tool output is not
treated as a decision. Long entries remain explicitly clipped, and secrets are
redacted before clipping. When a fact sheet calls an answer unrecoverable, check
the retained source rather than assuming a prior digest's truncation is a source
limit. Correct development ground truth for all systems in a new frozen cohort,
preserving the old inputs and results.

Retained user requests and decisions before the command-observation window remain
visible to judges as earlier context, with current requests prioritized when the
excerpt is full. Older command results remain outside that window. Earlier
context does not establish why a particular later fix was made. Provider metadata
and compaction recaps are not labeled as user requests.

## Metrics still to build

1. **Accuracy checker.** Independently validate extracted claims against code and execution evidence, classify mismatches with Gong et al.'s taxonomy, and validate against their labelled PRs. Until then, accuracy comes from model judgments under the v4 evidence contract; synthetic regression tests do not establish semantic judge reliability.
2. **Cold-read comprehension.** A reader model sees only the title and body and answers questions generated from the fact sheet.
3. **Deterministic signals.** Title rules, template compliance, coverage of behaviour-changing files, commit hygiene. (Length and cost are already in the report.)
4. **Real-world signals.** Edit distance before posting, merged as-is vs. after revision, time to first review.
5. **Human calibration and mutation tests** (below).

## Calibration (planned)

- **Human labels:** two or three people label 60–100 pairs. Report human–human agreement as the ceiling, and judge–human agreement as Cohen's kappa or Krippendorff's alpha. A judge is trusted on a dimension only at alpha ≥ 0.6.
- **Mutation tests:** inject known faults (a fabricated claim, a false "tests pass", a dropped key change) into good descriptions and require the targeted metric to drop.

## Avoiding overfitting

Tools under test may have been tuned on some cases (Tracetoon was tuned on its own PRs). Every case is `dev` or `test`; tool authors may look at `dev` results only, and reports show the two splits separately. Synthetic cases are for tests and templates, not results.

## Roadmap

| Milestone | Scope |
|---|---|
| **M0 scaffold** (done) | Case and artifact schemas, sandbox, fake `gh`, `original` system, CLI (`validate`, `systems`, `run`, `check-artifact`), synthetic example case, these docs. |
| **M1 first comparison** (this milestone) | Tracetoon's eval cases imported locally with session slices. `claude-native` and `tracetoon` systems. Blind pairwise judging in both orders by two model families, statistics and report. Sandbox fetch blocked and fact-sheet path hidden from systems. |
| **M2 accuracy checker** | Claim extraction and checking; validate against Gong et al.'s labelled PRs. Resumed-session baseline for short sessions. |
| **M3 calibration** | Human labeling round, agreement statistics, mutation tests; freeze judge prompt v1. |
| **M4 scale** | 50+ held-out replay cases across repositories and agents; end-to-end pilot on about 30 SWE-bench Verified tasks. |
| **M5 operate** | Regression gate for PR tools' release candidates, published reports, real-world signals. |
