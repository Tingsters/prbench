# prbench

An evaluation harness for tools that write or change the pull requests produced by AI coding agents.

It answers: **does this PR tool produce better pull requests than the agent would have without it?** It runs each system on the same fixed cases, collects the PR each one would have opened, and scores those PRs for accuracy and usefulness to a reviewer.

> **Status: milestone 1.** Five systems (`original`, `claude-native`, `tracetoon`, `codex-native`, `codex-tracetoon`), blind pairwise judging and reports. A dedicated accuracy checker and human calibration come next; see the [roadmap](docs/methodology.md#roadmap).

## Why

No existing benchmark scores the whole PR (title, description, commits and whether the text matches the diff) or compares a PR tool against a baseline. Research shows description–diff mismatch is the strongest sign of a bad agent PR, and that word-overlap metrics like BLEU and ROUGE track human judgment poorly. See [docs/related-work.md](docs/related-work.md).

## Quick start

Needs [Bun](https://bun.sh) 1.3.14 or later and git.

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

- A **case** (`cases/<id>/`) fixes the starting point: a repo snapshot, the task and, for replay cases, the recorded agent sessions and resulting commits. [docs/cases.md](docs/cases.md)
- A **system** (`src/systems/`) turns a case into a **PR artifact** (`src/schema/artifact.ts`). Systems run in a **sandbox** (`src/run/sandbox.ts`) with their own home directory holding only the case's sessions, a fake `gh` that captures PRs, and a local remote for pushes.
- **Metrics** only see artifacts, so any PR tool can be compared with any other. [docs/methodology.md](docs/methodology.md)

## Adding a system

Implement `System` from `src/systems/types.ts` and register it in `src/systems/index.ts`. A system gets the loaded case (without its fact sheet) and a sandbox, runs whatever it needs with `sandbox.env` inside `sandbox.repo`, and returns a `PRArtifact`. PRs opened through `gh pr create` are available from `sandbox.capturedPRs()`. Use the provider's shared runner (`runClaude` or `runCodex`) and `PR_PROMPT` so each tool flow differs from its native baseline only in what it installs.

## License

Apache-2.0
