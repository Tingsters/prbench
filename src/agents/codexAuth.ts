import { cancellationSignal } from "../run/cancellation.ts";
// A dedicated login cache, separate from the user's interactive Codex session.
// Serialize checkout/use/return of the cache so rotating OAuth refresh tokens
// cannot race across sandboxed writers and judges. Never copy the main login.
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_CODEX_AUTH_HOME = join(
  homedir(),
  ".prbench",
  "codex-auth",
);

function canonical(path: string): string {
  const full = existsSync(path) ? realpathSync(path) : resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

export function codexAuthHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = resolve(env.PRBENCH_CODEX_AUTH_HOME ?? DEFAULT_CODEX_AUTH_HOME);
  const interactive = resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
  if (canonical(dir) === canonical(interactive))
    throw new Error(
      "Use a separate benchmark Codex login cache, not the interactive CODEX_HOME.",
    );
  return dir;
}

export function codexCommand(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!env.PRBENCH_CODEX_COMMAND) return ["codex"];
  const cmd: unknown = JSON.parse(env.PRBENCH_CODEX_COMMAND);
  if (
    !Array.isArray(cmd) ||
    !cmd.length ||
    !cmd.every((x) => typeof x === "string" && x.length)
  ) {
    throw new Error(
      "PRBENCH_CODEX_COMMAND must be a non-empty JSON array of command arguments.",
    );
  }
  return cmd;
}

/** OAuth runs must not silently select an inherited API key or expose the login source. */
export function codexRunEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const codexHome =
    base.CODEX_HOME ??
    Object.entries(base).find(
      ([key]) => key.toUpperCase() === "CODEX_HOME",
    )?.[1];
  return {
    ...Object.fromEntries(
      Object.entries(base).filter(
        ([key]) =>
          !key.toUpperCase().startsWith("CODEX_") &&
          ![
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "PRBENCH_CODEX_AUTH_HOME",
          ].includes(key.toUpperCase()),
      ),
    ),
    ...(codexHome === undefined ? {} : { CODEX_HOME: codexHome }),
  };
}

/** Interactive CLI entry point: credentials and browser URLs stay in the user's terminal. */
export function codexLogin(status = false, deviceAuth = false): number {
  const dir = codexAuthHome();
  const leased = existsSync(dir)
    ? readdirSync(dir).some((name) => {
        const m = /^prbench-shared-(\d+)\.lease$/.exec(name);
        if (!m) return false;
        try {
          process.kill(Number(m[1]), 0);
          return true;
        } catch {
          return false;
        }
      })
    : false;
  if (!status && (leased || existsSync(join(dir, "prbench.lock"))))
    throw new Error(
      "A benchmark holds this Codex login cache. Let it finish before signing in again.",
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const args = [
    ...codexCommand(),
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
  ];
  if (status) args.push("status");
  else if (deviceAuth) args.push("--device-auth");
  console.log(`Benchmark Codex login cache: ${dir}`);
  const proc = Bun.spawnSync(args, {
    env: { ...process.env, CODEX_HOME: dir },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode;
}

async function acquire(lock: string, timeoutMs: number): Promise<() => void> {
  const started = Date.now();
  while (true) {
    if (cancellationSignal()?.aborted)
      throw new Error(
        "Cancelled while waiting for the benchmark Codex login cache.",
      );
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        closeSync(fd);
      }
      return () => unlinkSync(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Fail clearly on a killed controller; concurrent waiters must not race
      // to delete and replace one another's authentication lock.
      let dead = false;
      try {
        const { pid } = JSON.parse(readFileSync(lock, "utf8")) as {
          pid: number;
        };
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            dead = (e as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        // An empty lock may be between creation and writing; only diagnose an old one as stale.
        try {
          dead = Date.now() - statSync(lock).mtimeMs > 60_000;
        } catch {
          /* retry */
        }
      }
      if (dead)
        throw new Error(
          `Stale benchmark Codex login lock: ${lock}. Its controller exited; remove that lock file before retrying.`,
        );
      if (Date.now() - started > timeoutMs)
        throw new Error(
          "Timed out waiting for the benchmark Codex login cache. Another Codex eval is still using it.",
        );
      await delay(100);
    }
  }
}

let sharedLogin = false;

/**
 * Parallel runs share one login file instead of serializing on a copy. Each
 * sandbox's `auth.json` is a symlink to the dedicated cache, the way several
 * interactive Codex sessions share `~/.codex/auth.json`: Codex refreshes and
 * rotates tokens in place through the link, so no copy can go stale. Verified
 * with codex-cli 0.164 under three concurrent forced refreshes. Windows keeps
 * the exclusive copy mode (symlinks need extra privileges there).
 */
export function setCodexLoginSharing(on: boolean): void {
  sharedLogin = on && process.platform !== "win32";
}

export function codexLoginSharing(): boolean {
  return sharedLogin;
}

function leaseFile(sourceDir: string): string {
  return join(sourceDir, `prbench-shared-${process.pid}.lease`);
}

async function withSharedCodexAuth<T>(
  sourceDir: string,
  target: string,
  destination: string,
  fn: () => Promise<T>,
  onAcquired?: (waitMs: number) => void,
): Promise<T> {
  const waiting = performance.now();
  // The lock only orders link creation against `prbench auth codex`; the run
  // itself holds a per-controller lease so a sign-in cannot replace the file
  // underneath it.
  const release = await acquire(join(sourceDir, "prbench.lock"), 60_000);
  try {
    writeFileSync(leaseFile(sourceDir), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    if (lstatExists(target)) unlinkSync(target);
    symlinkSync(join(sourceDir, "auth.json"), target);
  } finally {
    release();
  }
  onAcquired?.(performance.now() - waiting);
  try {
    return await fn();
  } finally {
    if (lstatExists(target)) unlinkSync(target);
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove this controller's shared-login lease (call once its runs are done). */
export function releaseCodexLoginLease(
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    unlinkSync(leaseFile(codexAuthHome(env)));
  } catch {
    /* none held */
  }
}

/** Returns refreshed credentials even on run failure, then removes the sandbox copy. */
export async function withCodexAuth<T>(
  destination: string,
  fn: () => Promise<T>,
  opts: {
    env?: Record<string, string | undefined>;
    waitMs?: number;
    onAcquired?: (waitMs: number) => void;
  } = {},
): Promise<T> {
  const sourceDir = codexAuthHome(opts.env);
  const source = join(sourceDir, "auth.json");
  if (!existsSync(source))
    throw new Error(
      "No benchmark Codex login. Run `bun run prbench auth codex` in a separate terminal, complete sign-in, then retry.",
    );
  if (canonical(destination) === canonical(sourceDir))
    throw new Error("The Codex run must have its own sandbox CODEX_HOME.");
  if (sharedLogin)
    return withSharedCodexAuth(
      sourceDir,
      join(destination, "auth.json"),
      destination,
      fn,
      opts.onAcquired,
    );
  const waiting = performance.now();
  const release = await acquire(
    join(sourceDir, "prbench.lock"),
    opts.waitMs ?? 24 * 60 * 60_000,
  );
  const target = join(destination, "auth.json");
  try {
    opts.onAcquired?.(performance.now() - waiting);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    writeFileSync(target, readFileSync(source), { mode: 0o600 });
    try {
      return await fn();
    } finally {
      if (existsSync(target)) {
        const temp = join(dirname(source), `auth-${process.pid}.tmp`);
        try {
          writeFileSync(temp, readFileSync(target), { mode: 0o600 });
          renameSync(temp, source);
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      }
    }
  } finally {
    try {
      if (existsSync(target)) unlinkSync(target);
    } finally {
      release();
    }
  }
}
