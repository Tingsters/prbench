import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  canonicalCheck,
  checkExecution,
} from "../src/agents/validationCheck.ts";
import {
  compareValidationWork,
  validationCoverage,
  type ValidationWork,
} from "../src/validationWork.ts";
import { cleanupTemps, tempDir } from "./helpers.ts";
import { completedWork } from "./fixtures/validation-work.ts";
afterAll(cleanupTemps);

test("canonical checks resolve literal aliases and wrappers without interpreting shell expressions", () => {
  const repo = tempDir();
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts/bundle.ts"), "console.log('built');");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      scripts: {
        test: "bun test",
        typecheck: "bun x tsc --noEmit",
        lint: "eslint . && prettier --check .",
        bundle: "bun run scripts/bundle.ts",
        "test:cycle": "bun run test:cycle",
      },
    }),
  );
  expect(canonicalCheck("bun run test", "<repo>", repo)?.argv).toEqual([
    "bun",
    "test",
  ]);
  expect(canonicalCheck("bun run typecheck", "<repo>", repo)?.argv).toEqual([
    "bun",
    "x",
    "tsc",
    "--noEmit",
  ]);
  expect(
    canonicalCheck(
      '"C:\\Program Files\\PowerShell\\pwsh.exe" -Command "bun test"',
      "<repo>",
      repo,
    )?.argv,
  ).toEqual(["bun", "test"]);
  const wrapped = canonicalCheck(
    ".agents/skills/tracetoon/bin/tracetoon.cmd check --run 123 --name tests -- bun test",
    "<repo>",
    repo,
  )!;
  expect(checkExecution(wrapped, "tests: passed; 321ms").execution).toBe(
    "fresh",
  );
  expect(
    checkExecution(wrapped, "tests: passed (reused unchanged inputs); 321ms")
      .execution,
  ).toBe("receipt-reuse");
  expect(canonicalCheck("bun test && echo done", "<repo>", repo)?.kind).toBe(
    "unknown",
  );
  expect(canonicalCheck("bun run lint", "<repo>", repo)?.kind).toBe("unknown");
  expect(canonicalCheck("bun run bundle", "<repo>", repo)?.argv).toEqual([
    "bun",
    "scripts/bundle.ts",
  ]);
  expect(canonicalCheck("bun run test:cycle", "<repo>", repo)?.kind).toBe(
    "unknown",
  );
  expect(canonicalCheck("bun test", "unknown", repo)?.kind).toBe("unknown");
  expect(
    canonicalCheck("echo 'bun test passed'", "<repo>", repo),
  ).toBeUndefined();
});
test("interrupted, unknown-content, changed-target and legacy runs cannot establish comparable validation", () => {
  const baseline = completedWork(),
    candidate = completedWork();
  expect(compareValidationWork(baseline, candidate).status).toBe("matched");
  candidate.validation!.commands[0]!.outcome = "interrupted";
  expect(compareValidationWork(baseline, candidate).status).toBe("unknown");
  candidate.validation!.commands[0]!.outcome = "completed";
  candidate.validation!.commands[0]!.check!.argv!.push("--timeout", "30000");
  expect(compareValidationWork(baseline, candidate).status).toBe("unmatched");
  candidate.validation!.commands[0]!.before = undefined;
  expect(compareValidationWork(baseline, candidate).status).toBe("unknown");
  expect(compareValidationWork({}, {}).status).toBe("unknown");
});
test("receipt reuse requires an earlier captured pass and duplicated checks do not inflate coverage", () => {
  const work = completedWork(),
    original = work.validation!.commands[0]!;
  work.validation!.commands.push({
    ...structuredClone(original),
    id: "V2",
    startedAt: "2026-11-03T00:00:02Z",
    check: { ...original.check!, execution: "receipt-reuse" },
  });
  expect(validationCoverage(work).reasons).toEqual([]);
  expect(validationCoverage(work).coverage).toHaveLength(1);
  original.outcome = "tool-error";
  expect(validationCoverage(work).reasons.join(" ")).toContain(
    "no earlier captured pass",
  );
});
