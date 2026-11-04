import { expect, test } from "bun:test";
import { adoptionGate } from "../src/gates.ts";
const input = {
  complete: true,
  purpose: "confirmation",
  quality: "passed",
  performance: "passed",
  policyCurrent: true,
  pendingCleanup: 0,
  writers: [
    {
      case: "c",
      model: "m",
      system: "tracetoon-candidate",
      replicate: 1,
      workflow: {
        declaredIndependentRoles: 3,
        reviewCurrent: true,
        reviewVersion: 2,
      },
    },
  ],
};
test("adoption requires complete quality, efficiency and independent current review evidence", () => {
  expect(adoptionGate(input)).toMatchObject({
    passed: true,
    status: "passed",
    exitCode: 0,
  });
  expect(adoptionGate({ ...input, quality: "failed" })).toMatchObject({
    passed: false,
    status: "failed",
    exitCode: 1,
  });
  expect(
    adoptionGate({ ...input, complete: false, quality: "failed" }),
  ).toMatchObject({ passed: false, status: "incomplete", exitCode: 2 });
  for (const change of [
    { purpose: "diagnostic" },
    { policyCurrent: false },
    { pendingCleanup: 1 },
    { performance: "inconclusive" },
    { quality: "unknown" },
    { writers: [] },
  ])
    expect(adoptionGate({ ...input, ...change })).toMatchObject({
      passed: false,
      status: "inconclusive",
      exitCode: 3,
    });
  expect(
    adoptionGate({
      ...input,
      writers: [
        {
          ...input.writers[0]!,
          workflow: { ...input.writers[0]!.workflow, reviewVersion: 1 },
        },
      ],
    }).passed,
  ).toBe(false);
  expect(
    adoptionGate({
      ...input,
      writers: [
        {
          ...input.writers[0]!,
          workflow: {
            ...input.writers[0]!.workflow,
            declaredIndependentRoles: 2,
          },
        },
      ],
    }).passed,
  ).toBe(false);
});
