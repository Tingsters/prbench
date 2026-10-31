# prbench

An evaluation harness for tools that write or change the pull requests produced by AI coding agents.

It answers: **does this PR tool produce better pull requests than the agent would have without it?** It runs each system on the same fixed cases, collects the PR each one would have opened, and scores those PRs for accuracy and usefulness to a reviewer.

> **Status: milestone 0.** Cases, PR artifacts, the sandbox and the `original` system work. Agent adapters, judges and metrics come next; see the [roadmap](docs/methodology.md#roadmap).

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
bun test
bun run typecheck
```

`run --keep-sandbox` leaves the sandbox on disk so you can inspect it.

## How it fits together

- A **case** (`cases/<id>/`) fixes the starting point: a repo snapshot, the task and, for replay cases, the recorded agent sessions and resulting commits. [docs/cases.md](docs/cases.md)
- A **system** (`src/systems/`) turns a case into a **PR artifact** (`src/schema/artifact.ts`). Systems run in a **sandbox** (`src/run/sandbox.ts`) with their own home directory holding only the case's sessions, a fake `gh` that captures PRs, and a local remote for pushes.
- **Metrics** only see artifacts, so any PR tool can be compared with any other. [docs/methodology.md](docs/methodology.md)

## Adding a system

Implement `System` from `src/systems/types.ts` and register it in `src/systems/index.ts`. A system gets the loaded case and a sandbox, runs whatever it needs with `sandbox.env` inside `sandbox.repo`, and returns a `PRArtifact`. PRs opened through `gh pr create` are available from `sandbox.capturedPRs()`.

## License

Apache-2.0
