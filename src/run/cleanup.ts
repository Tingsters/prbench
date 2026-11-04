import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { recordEvent } from "./ledger.ts";

export interface Ownership {
  root: string;
  parent: string;
  token: string;
}
export function ownSandbox(root: string): Ownership {
  const owner = {
    root: realpathSync(root),
    parent: realpathSync(dirname(root)),
    token: randomUUID(),
  };
  writeFileSync(join(root, ".prbench-owner.json"), JSON.stringify(owner));
  return owner;
}
export function cleanupOwned(
  owner: Ownership,
  dispose = () =>
    rmSync(owner.root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    }),
): void {
  if (!existsSync(owner.root)) return;
  if (
    resolve(owner.root) !== realpathSync(owner.root) ||
    realpathSync(dirname(owner.root)) !== owner.parent ||
    resolve(owner.root) === resolve(owner.parent)
  )
    throw new Error("Cleanup root escaped its recorded parent.");
  const actual = JSON.parse(
    readFileSync(join(owner.root, ".prbench-owner.json"), "utf8"),
  );
  if (
    actual.token !== owner.token ||
    actual.root !== owner.root ||
    actual.parent !== owner.parent
  )
    throw new Error("Sandbox ownership does not match; refusing cleanup.");
  const identity = lstatSync(owner.root);
  try {
    dispose();
  } catch (error) {
    // Recursive removal may delete the marker before a locked child prevents
    // removing the root. Restore recovery only for the same physical directory;
    // never adopt a replacement root or overwrite another ownership marker.
    try {
      const remaining = lstatSync(owner.root);
      if (
        remaining.dev === identity.dev &&
        remaining.ino === identity.ino &&
        remaining.birthtimeMs === identity.birthtimeMs &&
        resolve(owner.root) === realpathSync(owner.root) &&
        realpathSync(dirname(owner.root)) === owner.parent
      ) {
        writeFileSync(
          join(owner.root, ".prbench-owner.json"),
          JSON.stringify(owner),
          { flag: "wx" },
        );
      }
    } catch {
      /* Preserve the original disposal error and refuse uncertain recovery. */
    }
    throw error;
  }
}
export function cleanupExperiment(dir: string): {
  removed: number;
  pending: number;
} {
  const root = realpathSync(dir);
  let removed = 0,
    pending = 0;
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name !== "inputs") visit(file);
        continue;
      }
      if (!entry.name.endsWith(".status.json") || !lstatSync(file).isFile())
        continue;
      const status = JSON.parse(readFileSync(file, "utf8"));
      if (status.cleanup?.state !== "pending") continue;
      try {
        cleanupOwned(status.cleanup.owner);
        status.cleanup.state = "removed";
        delete status.cleanup.error;
        writeFileSync(file, JSON.stringify(status, null, 2) + "\n");
        if (
          existsSync(join(root, "manifest.json")) &&
          JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
            .schema === "prbench.comparison/v2"
        )
          recordEvent(root, {
            stage: "cleanup",
            key: status.cleanup.owner.token,
            kind: "recovered",
            artifact: file,
          });
        removed++;
      } catch {
        pending++;
      }
    }
  };
  visit(root);
  return { removed, pending };
}
