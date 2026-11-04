import { expect, test } from "bun:test";
import {
  afterEnd,
  beforeEnd,
  fallbackTurn,
  mixedTurn,
} from "./fixtures/scope-calibration.ts";

test("scope calibration has an executed changed-path example and a reachable fallback counterexample", () => {
  expect(beforeEnd(mixedTurn)).toBe(20);
  expect(afterEnd(mixedTurn)).toBe(10);
  expect(afterEnd(fallbackTurn)).toBe(20);
  expect(afterEnd([...fallbackTurn, { at: 30, repoEdit: false }])).toBe(30);
});
