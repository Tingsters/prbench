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
| `repo.bundle` / `repo.url` | Exactly one. A bundle keeps the case self-contained: `git bundle create repo.bundle <branch>`, which must contain both commits. |
| `repo.base` | Full or abbreviated commit SHA the change starts from. |
| `repo.head` | Commit with the finished change. Required for replay. |
| `repo.branch` | Work branch in the sandbox. Defaults to `prbench/<id>`. Not `main`. |
| `task` | The request as the user phrased it. |
| `sessions[]` | `{agent, file, cwd}`. `agent` is `claude-code` or `codex`. `cwd` is the directory the session was recorded in, as written in the log; the sandbox rewrites it. |
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

## Privacy

Session logs contain prompts, file contents and command output. Before adding a real case:

- Get the session owner's consent.
- Redact secrets, tokens, personal data and unrelated work.
- Don't commit cases from private repositories to a shared or public cases directory. Keep them in a separate private location.
