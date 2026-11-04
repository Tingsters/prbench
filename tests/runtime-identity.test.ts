import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeIdentity } from "../src/run/comparisonInputs.ts";
import { digest } from "../src/util/hash.ts";
import { tempDir, cleanupTemps } from "./helpers.ts";
afterAll(cleanupTemps);
test("modern build provenance compares public identity fields and binds output receipts", () => {
  const root = tempDir(),
    runtime = join(
      root,
      process.platform === "win32" ? "runtime.exe" : "runtime",
    ),
    source = join(root, "runtime.ts");
  const manifest = {
    version: "0.0.0-test",
    buildId: "a".repeat(64),
    revision: null,
    protocol: 2,
    dependencies: [
      {
        name: "test",
        revision: "b".repeat(40),
        packageTree: "c".repeat(40),
        sha256: "d".repeat(64),
      },
    ],
    compiler: { name: "bun", version: Bun.version },
    recipe: { bunVersion: Bun.version },
  };
  const { recipe, ...publicFields } = manifest;
  writeFileSync(
    source,
    `console.log(${JSON.stringify(JSON.stringify({ ...publicFields, capabilities: ["shared-preparation"] }))});`,
  );
  const build = Bun.spawnSync(
    [process.execPath, "build", "--compile", source, "--outfile", runtime],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode).toBe(0);
  writeFileSync(join(root, "build.json"), JSON.stringify(manifest));
  const receipt = {
    schema: "tracetoon.build-output/v1",
    buildId: manifest.buildId,
    target: `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    sha256: digest(readFileSync(runtime)),
    inputManifestSha256: digest(readFileSync(join(root, "build.json"))),
    compiler: {
      version: Bun.version,
      sha256: digest(readFileSync(process.execPath)),
    },
  };
  writeFileSync(`${runtime}.build.json`, JSON.stringify(receipt));
  expect(runtimeIdentity(root, runtime, true).sha256).toBe(receipt.sha256);
  writeFileSync(
    `${runtime}.build.json`,
    JSON.stringify({ ...receipt, sha256: "0".repeat(64) }),
  );
  expect(() => runtimeIdentity(root, runtime, true)).toThrow("output receipt");
});
