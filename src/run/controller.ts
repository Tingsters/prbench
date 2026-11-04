/** Recover only our experiment lock after its recorded process has exited. */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { recordEvent } from "./ledger.ts";
export function controllerLock(
  root: string,
  experiment: string,
  recover = false,
) {
  const file = join(root, "controller.lock");
  if (recover && existsSync(file)) {
    const bytes = readFileSync(file, "utf8"),
      owner = JSON.parse(bytes);
    if (
      owner.id !== experiment ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      throw new Error("Controller lock has invalid or foreign ownership.");
    let exited = false;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") exited = true;
      else
        throw new Error(
          "Controller ownership cannot be checked; lock retained.",
        );
    }
    if (!exited)
      throw new Error(
        "Recorded controller process is still alive; lock retained.",
      );
    if (readFileSync(file, "utf8") !== bytes)
      throw new Error("Controller ownership changed during recovery.");
    unlinkSync(file);
    recordEvent(root, {
      stage: "preflight",
      key: `controller:${experiment}`,
      kind: "recovered",
      detail:
        "Removed an owned lock whose process had exited; no process was terminated.",
    });
  }
  const owner = JSON.stringify({
    pid: process.pid,
    id: experiment,
    nonce: randomUUID(),
  });
  try {
    writeFileSync(file, owner, { flag: "wx", mode: 0o600, flush: true });
  } catch {
    throw new Error(
      "Experiment controller lock exists. Inspect status and use --recover-lock only after its process exits.",
    );
  }
  return () => {
    if (!existsSync(file)) return;
    if (readFileSync(file, "utf8") !== owner)
      throw new Error("Controller lock ownership changed; lock retained.");
    unlinkSync(file);
  };
}
