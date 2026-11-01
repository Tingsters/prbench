# Methodology

prbench answers one question: **does a given PR-writing tool produce better pull requests than the agent would have produced without it?** "Better" means better for the person reviewing the PR. The design follows from the research in [related-work.md](related-work.md).

Status: milestone 1. Cases, artifacts, the sandbox, three systems (`original`, `claude-native`, `tracetoon`), the pairwise judge and the report exist. Accuracy checking beyond the judge, human calibration and the remaining metrics are planned; see [Roadmap](#roadmap).

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

Both agent systems get the same request, word for word (`PR_PROMPT` in `src/systems/agentShared.ts`), the same model and the same spending cap. They differ only in what is installed around the agent.

**Why `claude-native` runs in a fresh session.** The fairest "standard AI PR" is the agent writing the PR at the end of the session that did the work. Resuming the recorded session isn't practical for the seed cases: they come from one 78 MB session that started in the parent directory and produced several PRs. So the native baseline sees the repository, branch and commits but not the conversation. That makes it weaker than an in-session agent; `original` covers the in-session case where a published PR exists. A resumed-session baseline is a follow-up for cases with short single-task sessions.

### Agent credentials

A sandbox has its own `HOME`, so Claude Code can't use the user's normal login there. Copying `~/.claude/.credentials.json` in would be unsafe: a token refresh inside the sandbox could sign the user out. Agent systems instead use a long-lived token from `claude setup-token`, read from `~/.prbench/claude-oauth-token` or `PRBENCH_CLAUDE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`). See `src/agents/claude.ts`.

**Permissions.** Both agent systems get exactly the same tools: read, search, write and edit files, start subagents, and run any shell command (`AGENT_TOOLS` in `src/systems/agentShared.ts`), with `--permission-mode acceptEdits`. PowerShell is off, because Claude Code's PowerShell tool fails inside sandboxes on Windows. Anything else is denied, since nobody can approve it.

Trial runs showed why the shell is open. With an allow-list of commands, Tracetoon called its launcher in spellings the list didn't cover, and the repositories' checks ran their own tools. Each unlisted call needed an approval, so the run stalled. The project owner chose to allow any shell command (2026-10-31). Agents therefore run as the user. The sandbox redirects their home directory but is not a security boundary.

**Unattended.** The shared request tells both agents that nobody can answer questions and that anything the sandbox can't do should be noted, not asked about. Without that, a trial Tracetoon run stopped to ask what to do about checks it couldn't run (the sandbox has no installed dependencies).

**The git directory.** Claude Code won't let an unattended agent write under a `.git/` path, but Tracetoon keeps its run folder in the git directory. So the sandbox keeps its git directory outside the checkout, and both systems may use it.

## Sandbox

Each run gets a fresh sandbox (`src/run/sandbox.ts`):

- The repository is fetched from the case into `<root>/work/<name>`, named like the recorded checkout, with `main` and `origin/main` at the base commit and the work on a feature branch. Only those refs exist, so tools see an ordinary branch.
- `HOME`, `USERPROFILE`, `CODEX_HOME`, `APPDATA`, `LOCALAPPDATA` and the `XDG_*` directories point into the sandbox. The only agent logs there are the case's sessions.
- Paths recorded in the logs are rewritten: the repository's recorded path maps to the sandbox checkout, and its parent directory to the sandbox's `work` directory, so a session started from the parent still lines up. Only whole paths are rewritten.
- A fake `gh` on `PATH` records every call and turns `gh pr create` into a captured PR. Pushes go to a local bare repo. Git may only use local repositories (`GIT_ALLOW_PROTOCOL=file`), so nothing is fetched from or pushed to the network. GitHub tokens are removed from the environment.
- Systems get the case without its `facts` field, and the fact sheet is never copied into the sandbox.

The sandbox isolates discovery; it is not a security boundary. A process that uses absolute paths can still reach the real filesystem.

## Session slices

Real sessions are long and cover more than one change. The importer (`scripts/import-tracetoon-cases.ts`) keeps only records from an hour before the base commit to ten seconds after the head commit, and drops every record that writes PR text (Tracetoon run folders, `gh pr create` or `edit`), wherever it falls. The import fails if the published title or the opening of the published body still appears in a slice. A first version used a two-minute margin, which let one case include the original session drafting that case's published description; it was caught before any results were reported.

A slice may not start with a record bigger than 64 KB: readers find a session's working directory in the first 128 KB of the file, so a huge first record hides the whole session.

## Judging

`prbench judge` compares every pair of systems on every case with artifacts and a fact sheet (`src/judge/`).

- **Blind and normalized.** Tool markers, HTML comments, comics, comic transcripts and attribution footers ("Assisted-by", "Generated with Claude Code", "Co-Authored-By") are stripped before judging, so judges compare descriptions, not branding. Judges never see a tool's own self-review.
- **Both orders.** Each pair is judged with each system in position A once. A win needs both orders to agree; otherwise it is a tie, and a *flip* when the orders picked opposite systems.
- **Two model families.** `claude -p` (tools off, hooks off, no saved session) and `codex exec` (ephemeral, read-only), both run from an empty temp directory with structured output. A pair's result is reported per judge and as "all judges agree".
- **What a judge sees.** The fact sheet, commits and diff. A neutral excerpt of the work sessions (`src/judge/evidence.ts`): the user's requests, the commands run with the key lines of their output, and the files edited, from just before the base commit on. prbench builds the excerpt from the raw logs, never from a system's output. Without it, every claim a session-reading tool takes from the logs ("the full suite passed before the last edit") counted as unsupported. In the first judging round (rubric v1) that was most of Tracetoon's "unsupported claims". Judges also get a note that agent systems prepare PRs in a fresh copy without installed dependencies, so "the checks couldn't run here" is accurate, and a claim that checks passed needs session evidence.
- **What a judge returns** (`src/judge/rubric.ts`, rubric v2): per description, factual errors, unsupported claims, fact-sheet claims and context covered, uncertainties respected, traps hit, and 0–2 scores on ten reviewer-usefulness items (Tracetoon's rubric v2 plus requested feedback, links and scope). Then a preference with a reason. Accuracy comes first, then usefulness, then the reader's effort; length is not a virtue.
- **Caching.** Each judgment is stored under `results/judgments/` with a hash of its prompt and reused while the prompt is unchanged.
- **Statistics** (`src/stats.ts`): win counts, win rate, an exact two-sided sign test, a 95% bootstrap interval on the mean per-case result, and Cohen's kappa between judges. Dev and test splits are reported separately.

A sanity check run on case `pr12` (the published PR against an identical copy) came out a tie for both judges in both orders.

## Metrics still to build

1. **Accuracy checker.** Extract each claim and check it against the diff and sessions (supported, overstated, unsupported, contradicted), classify mismatches with Gong et al.'s taxonomy, and validate against their labelled PRs. Until then, accuracy comes from the judges' factual-error and unsupported-claim lists.
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
