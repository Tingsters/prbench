# Methodology

prbench answers one question: **does a given PR-writing tool produce better pull requests than the agent would have produced without it?** "Better" means better for the person reviewing the PR. The design follows from the research in [related-work.md](related-work.md).

Status: milestone 0. Cases, artifacts, the sandbox and the `original` system exist. Everything under "Metrics" and "Judges" is planned; see [Roadmap](#roadmap).

## Terms

- **Case.** A fixed starting point every system receives unchanged: a repository snapshot, the task the agent was given and, for replay cases, the recorded agent sessions and the commits they produced. See [cases.md](cases.md).
- **Fact sheet.** Hand-checked facts about a case's change, written from the code and sessions only, never from a PR description: claims a good description conveys, context a reviewer wants, what the evidence doesn't establish, and plausible wrong statements ("traps"). It is the answer key, so systems never see it.
- **System.** Anything that turns a case into a PR: an agent's native "open a PR" flow, the same flow with a PR tool installed, or the PR actually published (`original`).
- **Artifact.** What a reviewer would receive: title, body, commits and diff, plus run metadata (`src/schema/artifact.ts`). Metrics only ever see artifacts, which is what keeps prbench independent of any particular tool.

## Run modes

1. **Replay (primary).** The recorded sessions and the finished change are held fixed; only the step that writes the PR varies. This isolates the tool's effect and is cheap and repeatable.
2. **End-to-end (later).** The agent solves the task from scratch with and without the tool. This catches effects on scope and commits, but the code differs between runs, so comparisons are noisier.

## Sandbox

Each run gets a fresh sandbox (`src/run/sandbox.ts`):

- The repo is cloned from the case with `main` and `origin/main` at the base commit and the work on a feature branch, so tools see an ordinary branch.
- `HOME`, `USERPROFILE` and `CODEX_HOME` point into the sandbox and hold only the case's sessions. Recorded working directories inside the logs are rewritten to the sandbox checkout, so tools that match sessions to repositories by path still find them.
- A fake `gh` on `PATH` records every call and turns `gh pr create` into a captured PR. Pushes go to a local bare repo. GitHub tokens are removed from the environment.
- The fact sheet is never copied in.

The sandbox isolates discovery; it is not a security boundary. A process that uses absolute paths can still reach the real filesystem.

Agents need credentials to run. With `HOME` redirected, an agent can't use the user's normal login, so adapters pass an API key through the environment. (Decided per adapter in milestone 1.)

## Metrics (planned)

Reported per dimension. There is deliberately no single blended score.

1. **Accuracy (primary).** Extract each claim from the description and check it against the diff and sessions: supported, overstated, unsupported or contradicted. Record omissions of important changes and classify mismatches with Gong et al.'s taxonomy. Also score against the fact sheet: claims covered, traps hit, uncertainties overclaimed.
2. **Reviewer usefulness rubric (0, 1 or 2 per item).** Problem, rationale, validation, consequences, orientation, entry point, economy (from tracetoon's rubric v2), plus requested feedback, testing information, links/intent and scope.
3. **Pairwise preference.** Blind, judged in both orders, word counts reported beside every preference. Win rate with a sign test and bootstrap confidence intervals; Bradley–Terry once there are more than two systems.
4. **Cold-read comprehension.** A reader model sees only the title and body and answers questions generated from the fact sheet (what changed, where to start, what is risky).
5. **Deterministic signals.** Length, title rules, template compliance, coverage of behaviour-changing files, commit hygiene, cost, latency.
6. **Real-world signals (later).** Edit distance before posting, merged as-is vs. after revision, time to first review.

## Judges (planned)

- Two judges from different model families, so a judge can't favour text from its own family.
- Every pair judged in both orders. A disagreement counts as a tie, and the flip rate is reported.
- Tool branding, comics and footers are stripped before judging so judges can't tell systems apart. Judges never see a tool's own self-review.
- Judge prompts are versioned and results record the version.
- **Human calibration:** two or three people label 60–100 pairs. Report human–human agreement as the ceiling, and judge–human agreement as Cohen's kappa or Krippendorff's alpha. A judge is trusted on a dimension only at alpha ≥ 0.6.
- **Mutation tests:** inject known faults (a fabricated claim, a false "tests pass", a dropped key change) into good descriptions and require the targeted metric to drop.

## Avoiding overfitting

Tools under test may have been tuned on some cases (tracetoon was tuned on its own PRs). Every case is `dev` or `test`; tool authors may look at `dev` results only, and reports show the two splits separately. Synthetic cases are for tests and templates, not results.

## Roadmap

| Milestone | Scope |
|---|---|
| **M0 scaffold** (done) | Case and artifact schemas, sandbox, fake `gh`, `original` system, CLI (`validate`, `systems`, `run`, `check-artifact`), synthetic example case, these docs. |
| **M1 first comparison** | Port tracetoon's eval cases and fact sheets (privately where a repo is private). Adapters for an agent's native PR flow and for tracetoon. Pairwise judge and rubric. Reproduce the direction of tracetoon's internal result on these cases. |
| **M2 accuracy checker** | Claim extraction and checking; validate against Gong et al.'s labelled PRs. |
| **M3 calibration** | Human labeling round, agreement statistics, mutation tests; freeze judge prompt v1. |
| **M4 scale** | 50+ held-out replay cases across repositories and agents; end-to-end pilot on about 30 SWE-bench Verified tasks. |
| **M5 operate** | Regression gate for PR tools' release candidates, published reports, real-world signals. |
