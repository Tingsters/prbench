import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { controllerLock } from "../src/run/controller.ts";
import { readEvents } from "../src/run/ledger.ts";
import { tempDir, cleanupTemps } from "./helpers.ts";
afterAll(cleanupTemps);
test("lock recovery retains live and foreign owners, recovers only an exited controller", () => {
  const root = tempDir(),
    release = controllerLock(root, "experiment"),
    file = join(root, "controller.lock"),
    bytes = readFileSync(file, "utf8");
  expect(() => controllerLock(root, "experiment", true)).toThrow("still alive");
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(() => controllerLock(root, "other", true)).toThrow("foreign");
  release();
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    windowsHide: true,
  });
  expect(exited.status).toBe(0);
  writeFileSync(file, JSON.stringify({ pid: exited.pid, id: "experiment" }));
  const resumed = controllerLock(root, "experiment", true);
  expect(readEvents(root).map((e) => e.kind)).toEqual(["recovered"]);
  expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
  resumed();
});
