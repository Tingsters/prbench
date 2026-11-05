import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { digest } from "../util/hash.ts";
import { implementationDigest, stageKey } from "./cache.ts";
import { windowsJobLauncher } from "../agents/ownedProcess.ts";
import { exec } from "../util/exec.ts";
/** Installed packages have no checkout; an ancestor repository is not the harness. */
export function harnessRevision(root: string): string | null {
  const top = exec(['git', 'rev-parse', '--show-toplevel'], { cwd: root });
  if (top.code) return null;
  const key = (path: string) => {
    const absolute = realpathSync(resolve(path));
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  if (key(top.stdout.trim()) !== key(root)) return null;
  const revision = exec(['git', 'rev-parse', 'HEAD'], { cwd: root });
  return revision.code === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null;
}
/** Bind executable bytes and script dependencies, not only an advertised version. */
export function commandIdentity(command: string[], root: string) {
  const executable = isAbsolute(command[0]!)
    ? command[0]!
    : Bun.which(command[0]!);
  if (!executable) throw new Error("Agent executable cannot be resolved.");
  const inputs = command
    .map((arg, index) => (index === 0 ? executable : resolve(root, arg)))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .map((path) => {
      const name = relative(root, path).replace(/\\/g, "/");
      return {
        name,
        sha256: digest(readFileSync(path)),
        ...(/\.[cm]?[jt]s$/.test(path)
          ? { implementation: implementationDigest(root, [name]) }
          : {}),
      };
    });
  return stageKey("agent-command", { command, inputs });
}
export function ownerIdentity() {
  return process.platform === "win32"
    ? digest(readFileSync(windowsJobLauncher()))
    : "posix-process-group/v1";
}
