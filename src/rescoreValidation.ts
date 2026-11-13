/**
 * Re-scoring saved runs: recover the working directories the agent runtime
 * recorded in retained writer traces, so a saved run's validation can be
 * compared without new model calls. Saved artifacts stay byte-identical; the
 * recovered evidence is used for the performance gate only.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeTree, withRecordedDirectories } from "./agents/validation.ts";
import type { PRArtifact } from "./schema/artifact.ts";
import type {
  TreeObservation,
  ValidationEvidence,
} from "./schema/validation.ts";
import { exec } from "./util/exec.ts";

function traceLines(dir: string): string[] {
  const lines: string[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true }))
    if (f.isFile() && f.name.endsWith(".jsonl"))
      lines.push(...readFileSync(join(dir, f.name), "utf8").split("\n"));
  return lines;
}

/**
 * Checkouts of a case bundle at a final tree, made only to resolve package
 * scripts and script files for recovered commands. A checkout is used only
 * when its content fingerprint equals the writer's observed final tree, so it
 * holds exactly the bytes the writer validated.
 */
export function verifiedCheckouts() {
  const made = new Map<string, string | undefined>(),
    dirs: string[] = [];
  return {
    get(bundle: string, tree: TreeObservation): string | undefined {
      const key = JSON.stringify([bundle, tree.head, tree.fingerprint]);
      if (made.has(key)) return made.get(key);
      let repo: string | undefined;
      if (existsSync(bundle) && /^[0-9a-f]{40,64}$/.test(tree.head)) {
        const dir = mkdtempSync(join(tmpdir(), "prbench-rescore-"));
        dirs.push(dir);
        const path = join(dir, "repo"),
          git = (args: string[], cwd?: string) =>
            exec(["git", "-c", "core.autocrlf=false", ...args], { cwd })
              .code === 0;
        if (
          git(["init", "--quiet", path]) &&
          git(
            [
              "fetch",
              "--quiet",
              "--no-tags",
              bundle,
              "+refs/*:refs/prbench-source/*",
            ],
            path,
          ) &&
          git(
            [
              "-c",
              "advice.detachedHead=false",
              "checkout",
              "--quiet",
              "--detach",
              tree.head,
            ],
            path,
          )
        ) {
          const observed = observeTree(path);
          if (
            observed?.head === tree.head &&
            observed.fingerprint === tree.fingerprint
          )
            repo = path;
        }
      }
      made.set(key, repo);
      return repo;
    },
    dispose() {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The artifact's validation with recorded directories recovered from its
 * retained traces, or the saved validation unchanged when nothing is recovered.
 */
export function rescoredValidation(
  artifact: PRArtifact,
  tracesDir: string | undefined,
  checkout?: (tree: TreeObservation) => string | undefined,
): ValidationEvidence | undefined {
  const saved = artifact.validation;
  if (
    !saved ||
    !tracesDir ||
    !existsSync(tracesDir) ||
    !saved.commands.some((c) => c.cwd.startsWith("unknown"))
  )
    return saved;
  let lines: string[];
  try {
    lines = traceLines(tracesDir);
  } catch {
    return saved;
  }
  const recovered = withRecordedDirectories(saved, lines);
  if (recovered === saved) return saved;
  // Package scripts and script files resolve only against the validated bytes.
  const repo =
    saved.finalTree && checkout ? checkout(saved.finalTree) : undefined;
  return repo ? withRecordedDirectories(saved, lines, repo) : recovered;
}
