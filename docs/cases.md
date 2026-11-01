# Writing a case

A case lives in its own directory under `cases/`, named after its id:

```
cases/<id>/
  case.json        required
  repo.bundle      the repository snapshot (or set repo.url instead)
  session.jsonl    recorded agent sessions (replay cases)
  facts.json       fact sheet
  original.md      body of the PR that was published, if any
```

`cases/example-greet-default` is a complete synthetic example, built by `bun run example` (`scripts/make-example.ts`). Check cases with `bun run prbench validate`.

## case.json

| Field | Notes |
|---|---|
| `schema` | `"prbench.case/v1"` |
| `id` | Lowercase letters, digits and dashes; must match the directory name. |
| `title` | Short human name. |
| `split` | `dev` or `test`. Test cases are held out from tool authors. |
| `mode` | `replay` (sessions and change fixed) or `e2e` (agent solves the task). |
| `repo.bundle` / `repo.url` | Exactly one. A bundle keeps the case self-contained: `git bundle create repo.bundle <ref>`, which must contain both commits. Any ref works; the sandbox fetches them all. |
| `repo.base` | Full or abbreviated commit SHA the change starts from. |
| `repo.head` | Commit with the finished change. Required for replay. |
| `repo.branch` | Work branch in the sandbox. Defaults to `prbench/<id>`. Not `main`. |
| `repo.recordedPath` | Where the repository was checked out when the sessions were recorded, as the logs spell it. Defaults to the first session's `cwd`. The sandbox maps it, and its parent directory, onto the sandbox checkout. |
| `task` | The user's request when available. Imports from multi-task replay sessions may use a descriptive label, explicitly identified in `provenance.notes`; retain available original messages in the sessions. |
| `sessions[]` | `{agent, file, cwd}`. `agent` is `claude-code` or `codex`. `cwd` is the directory the session was recorded in, as written in the log: the repository or its parent. |
| `facts` | Path to the fact sheet. |
| `original` | `{title, body, url?}` for the PR that was published. Enables the `original` system. |
| `provenance` | `{source, synthetic?, license?, notes?}`. |

## Fact sheets

```json
{
  "schema": "prbench.facts/v1",
  "claims": ["What a good description conveys, each checkable against the diff or sessions"],
  "context": ["Why the change was made, prior behaviour, constraints"],
  "uncertainties": ["What the evidence doesn't establish, e.g. 'tests were not run'"],
  "traps": ["Plausible but wrong statements a writer might make"]
}
```

Write the fact sheet from the diff and sessions **before** reading any description of the change, including the original PR. Otherwise the answer key inherits that description's framing.

## Real cases: cases-local/

Real cases hold real session logs, so they live in `cases-local/`, which git ignores. Point commands at it with `--cases cases-local`.

`scripts/import-tracetoon-cases.ts` builds Tracetoon's eight description-eval cases there, on the machine that recorded them. Each case gets the repository bundle, the matched sessions cut to the case's time window, Tracetoon's hand-checked fact sheet, and the published PR when one exists. Sessions end ten seconds after the head commit; records that write PR text are removed throughout the slice, and importing fails if the published title or body opening remains. The three cases Tracetoon held out while designing its description rules are in the `test` split. Showtail is excluded because its contribution rules prohibit pull requests, leaving seven eligible cases.

These imports use descriptive replay task labels rather than reconstructing a single original request from sessions that span multiple changes. `provenance.notes` records that distinction. Both agent systems receive the shared PR request, and judges get available user messages through the session evidence.

## Privacy

Session logs contain prompts, file contents and command output. Before adding a real case:

- Get the session owner's consent.
- Redact secrets, tokens, personal data and unrelated work.
- Don't commit real cases. Keep them in `cases-local/` or another private location.
