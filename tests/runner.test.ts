import { afterAll, describe, expect, test } from "bun:test";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { checkArtifact, type PRArtifact } from "../src/schema/artifact.ts";
import { loadCase } from "../src/schema/case.ts";
import { runCase } from "../src/run/runner.ts";
import { original } from "../src/systems/original.ts";
import type { System } from "../src/systems/types.ts";
import { exec } from "../src/util/exec.ts";
import {
  cleanupTemps,
  copyExample,
  EXAMPLE,
  ROOT,
  tempDir,
} from "./helpers.ts";

afterAll(cleanupTemps);

describe("runCase", () => {
  const loaded = loadCase(EXAMPLE);
  test("an initial status-write failure still cleans the sandbox before any writer runs", async () => {
    const parent = tempDir(),
      out = join(tempDir(), "not-a-directory");
    writeFileSync(out, "file");
    let called = false;
    const spy: System = {
      ...original,
      run: async () => {
        called = true;
        throw new Error("writer must not run");
      },
    };
    await expect(
      runCase(loaded, spy, { sandboxParent: parent, outDir: out }),
    ).rejects.toThrow();
    expect(called).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
  });
  test("status persistence cannot mask a primary writer failure", async () => {
    const parent = tempDir(),
      out = tempDir();
    const spy: System = {
      ...original,
      run: async () => {
        const status = join(out, loaded.case.id, "original.status.json");
        unlinkSync(status);
        mkdirSync(status);
        throw new Error("primary writer failure");
      },
    };
    await expect(
      runCase(loaded, spy, { sandboxParent: parent, outDir: out }),
    ).rejects.toThrow("primary writer failure");
    expect(readdirSync(parent)).toEqual([]);
  });

  test("the original system packages the published PR with the case commits and diff", async () => {
    const out = tempDir();
    const parent = tempDir();
    const { artifact, path } = await runCase(loaded, original, {
      outDir: out,
      sandboxParent: parent,
    });
    expect(checkArtifact(artifact)).toEqual([]);
    expect(artifact.title).toBe("Greet 'world' when no name is given");
    expect(artifact.body).toBe(
      readFileSync(join(EXAMPLE, "original.md"), "utf8"),
    );
    expect(artifact.base).toBe(loaded.case.repo.base);
    expect(artifact.head).toBe(loaded.case.repo.head!);
    expect(artifact.commits).toEqual([
      {
        sha: loaded.case.repo.head!,
        message: "Greet 'world' when no name is given",
      },
    ]);
    expect(artifact.diff).toContain(
      "+  const who = typeof name === 'string' && name.trim() ? name.trim() : 'world';",
    );
    expect(artifact.diff).toContain("+++ b/greet.test.js");
    expect(JSON.parse(readFileSync(path!, "utf8"))).toEqual(artifact);
    expect(readdirSync(parent)).toEqual([]);
  });

  test("systems get the case without its fact sheet", async () => {
    let seen: unknown;
    const spy: System = {
      id: "spy",
      description: "test double",
      supports: () => ({ supported: true }),
      async run(ctx) {
        seen = ctx.loaded.case;
        const a = await original.run({ ...ctx, loaded });
        return { ...a, system: "spy" };
      },
    };
    expect(loaded.case.facts).toBe("facts.json");
    await runCase(loaded, spy, { sandboxParent: tempDir() });
    expect(seen).not.toHaveProperty("facts");
    expect(seen).not.toHaveProperty("original");
    expect(loaded.case.facts).toBe("facts.json"); // the caller's copy is untouched
  });

  test("refuses cases a system does not support", async () => {
    const { dir } = copyExample("no-original", (c) => delete c.original);
    await expect(runCase(loadCase(dir), original)).rejects.toThrow(
      /case has no original PR/,
    );
  });

  test("rejects invalid or mislabelled artifacts and still cleans up", async () => {
    const parent = tempDir();
    const make = (edit: (a: PRArtifact) => void): System => ({
      id: "fake",
      description: "test double",
      supports: () => ({ supported: true }),
      async run(ctx) {
        const a = await original.run({ ...ctx, loaded });
        a.system = "fake";
        edit(a);
        return a;
      },
    });
    await expect(
      runCase(
        loaded,
        make((a) => (a.title = "")),
        { sandboxParent: parent },
      ),
    ).rejects.toThrow(
      /invalid artifact:\n  title: expected a non-empty string/,
    );
    await expect(
      runCase(
        loaded,
        make((a) => (a.case = "other")),
        { sandboxParent: parent },
      ),
    ).rejects.toThrow(/labelled its artifact other\/fake/);
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("cli", () => {
  const cli = (...args: string[]) =>
    exec([process.execPath, join(ROOT, "src", "cli.ts"), ...args], {
      cwd: ROOT,
    });

  test("validate passes on the bundled cases and fails with details on broken ones", () => {
    const ok = cli("validate", "cases");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("ok    example-greet-default (replay, dev)");

    const { root } = copyExample("broken", (c) => (c.split = "nope"));
    const bad = cli("validate", root);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("split: expected one of dev, test");
  });

  test("run writes an artifact that check-artifact accepts", () => {
    const out = tempDir();
    const r = cli(
      "run",
      "-s",
      "original",
      "-c",
      "example-greet-default",
      "-o",
      out,
    );
    expect(r.code).toBe(0);
    const file = join(out, "example-greet-default", "original.json");
    expect(cli("check-artifact", file).stdout).toContain("ok");
  });

  test("run explains unknown systems and cases", () => {
    expect(cli("run", "-s", "nope").stderr).toContain(
      'unknown system "nope" (known: original, claude-native, tracetoon, codex-native, codex-tracetoon)',
    );
    expect(cli("run", "-s", "original", "-c", "missing").stderr).toContain(
      'no case "missing"',
    );
  });
});
