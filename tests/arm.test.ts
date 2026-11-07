import { expect, test } from "bun:test";
import { artifactMatchesArm, checkArms, parseArm, writerEffort } from "../src/run/arm.ts";

test("a writer spec is a model with an optional effort", () => {
  expect(parseArm("gpt-6-luna")).toEqual({ model: "gpt-6-luna" });
  expect(parseArm("gpt-6-luna@low")).toEqual({ model: "gpt-6-luna", effort: "low" });
  expect(writerEffort("gpt-6-luna")).toBe("medium");
  expect(writerEffort("claude-haiku-5-5@low")).toBe("low");
  for (const bad of ["", "@low", "m@", "m@low@high", "bad model"]) expect(() => parseArm(bad)).toThrow();
});

test("arms are checked against the provider's efforts and must be distinct", () => {
  expect(() => checkArms(["gpt-6-luna@low", "gpt-6-luna@medium", "gpt-6-luna"], "codex")).not.toThrow();
  expect(() => checkArms(["gpt-6-luna@none"], "codex")).not.toThrow();
  expect(() => checkArms(["claude-haiku-5-5@none"], "claude")).toThrow(/Unknown claude effort/);
  expect(() => checkArms(["m@low", "m@low"], "codex")).toThrow(/distinct/);
});

test("an artifact belongs to an arm only when its model and effort match", () => {
  const meta = { model: "gpt-6-luna", reasoningEffort: "low" };
  expect(artifactMatchesArm(meta, "gpt-6-luna@low")).toBe(true);
  expect(artifactMatchesArm(meta, "gpt-6-luna@medium")).toBe(false);
  // A bare spec keeps accepting the artifacts earlier experiments saved.
  expect(artifactMatchesArm({ model: "gpt-6-luna", reasoningEffort: "medium" }, "gpt-6-luna")).toBe(true);
  expect(artifactMatchesArm(meta, "gpt-6.1-terra@low")).toBe(false);
});
