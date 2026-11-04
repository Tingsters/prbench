import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runAgentProcess } from "../src/agents/process.ts";
import { tempDir, cleanupTemps } from "./helpers.ts";
afterAll(cleanupTemps);
test("owned launcher preserves argument quoting, Unicode stdin, output and failure exit", async () => {
  const result = await runAgentProcess(
    [
      process.execPath,
      "-e",
      "console.log(JSON.stringify({ args:process.argv.slice(1), input:await Bun.stdin.text() })); process.exit(7)",
      'a "quoted" argument',
      "trailing\\",
    ],
    {
      cwd: tempDir(),
      env: process.env,
      prompt: "café 🐈\nsecond line",
      timeoutMs: 10000,
    },
  );
  expect(result.exitCode).toBe(7);
  expect(result.outputComplete).toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    args: ['a "quoted" argument', "trailing\\"],
    input: "café 🐈\nsecond line",
  });
}, 15000);
test("owned descendants are removed after their primary process exits", async () => {
  const dir = tempDir(),
    marker = join(dir, "child.pid");
  const code = `const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'inherit',stderr:'inherit'}); await Bun.write(${JSON.stringify(marker)},String(child.pid)); console.log('finished'); process.exit(0);`;
  const result = await runAgentProcess([process.execPath, "-e", code], {
    cwd: dir,
    env: process.env,
    prompt: "",
    timeoutMs: 10000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("finished");
  expect(existsSync(marker)).toBe(true);
  const pid = Number(readFileSync(marker, "utf8"));
  await Bun.sleep(100);
  expect(() => process.kill(pid, 0)).toThrow();
}, 15000);
test("cancellation terminates owned processes without waiting for their timeout", async () => {
  const controller = new AbortController(),
    started = Date.now();
  const call = runAgentProcess(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    {
      cwd: tempDir(),
      env: process.env,
      prompt: "",
      timeoutMs: 20000,
      signal: controller.signal,
    },
  );
  setTimeout(() => controller.abort(), 150);
  const result = await call;
  expect(result.exitCode).not.toBe(0);
  expect(result.timedOut).toBe(false);
  expect(Date.now() - started).toBeLessThan(5000);
}, 10000);
