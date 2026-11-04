import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { digest } from "../util/hash.ts";

export function windowsJobLauncher(): string {
  const source = join(import.meta.dir, "windows-job.cs");
  const compiler = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  if (!existsSync(compiler))
    throw new Error(
      "Windows process ownership requires the .NET Framework C# compiler.",
    );
  const key = digest(
    Buffer.concat([readFileSync(source), readFileSync(compiler)]),
  );
  const dir = resolve(
      import.meta.dir,
      "../../node_modules/.cache/prbench-jobs",
      key,
    ),
    output = join(dir, "owned-process.exe");
  if (!existsSync(output)) {
    mkdirSync(dir, { recursive: true });
    const compiled = spawnSync(
      compiler,
      [
        "/nologo",
        "/target:exe",
        "/optimize+",
        "/reference:System.Web.Extensions.dll",
        `/out:${output}`,
        source,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (compiled.status !== 0)
      throw new Error(
        `Cannot compile Windows process owner: ${compiled.stdout} ${compiled.stderr}`,
      );
  }
  return output;
}
export function spawnOwned(
  cmd: string[],
  opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    prompt: string;
  },
) {
  const windows = process.platform === "win32";
  const proc = Bun.spawn(
    windows ? [windowsJobLauncher(), String(process.pid)] : cmd,
    {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      detached: !windows,
      stdin: new Blob([
        windows ? JSON.stringify({ cmd, ...opts }) : opts.prompt,
      ]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stop = () => {
    if (!windows) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (proc.exitCode === null) proc.kill(); // Windows closes the helper's exclusive job handle.
  };
  return { proc, stop };
}
