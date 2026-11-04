import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { digest } from "../util/hash.ts";
import { implementationDigest, stageKey } from "./cache.ts";
import { windowsJobLauncher } from "../agents/ownedProcess.ts";
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
