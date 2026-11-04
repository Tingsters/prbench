import type { ValidationWork } from "../../src/validationWork.ts";
export function completedWork(): ValidationWork {
  const tree = {
    head: "a".repeat(40),
    fingerprint: "b".repeat(64),
    at: "2026-11-03T00:00:00Z",
  };
  return {
    codeIdentity: {
      base: "c".repeat(40),
      head: tree.head,
      diffSha256: "d".repeat(64),
    },
    validation: {
      schema: "prbench.validation/v1",
      origin: "writer-run",
      coverage: "recorded",
      scope: "observed tool executions; not an attestation of test correctness",
      gaps: [],
      finalTree: tree,
      commands: [
        {
          id: "V1",
          source: "execution-record:fixture",
          command: "bun test",
          cwd: "<repo>",
          outcome: "completed",
          exitCode: 0,
          output: "1 pass",
          truncated: false,
          before: tree,
          after: tree,
          startedAt: "2026-11-03T00:00:00Z",
          completedAt: "2026-11-03T00:00:01Z",
          check: {
            kind: "check",
            argv: ["bun", "test"],
            cwd: ".",
            execution: "fresh",
          },
        },
      ],
    },
  };
}
