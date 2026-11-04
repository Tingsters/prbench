import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exec, git } from "../util/exec.ts";
import type { Sandbox } from "./sandbox.ts";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
const json = <T = any>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8"));
export function directoryDigest(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`Immutable inputs cannot contain symlinks: ${rel}`);
      if (entry.isDirectory()) walk(rel);
      else
        h.update(rel)
          .update("\0")
          .update(readFileSync(join(root, rel)))
          .update("\0");
    }
  };
  walk("");
  return h.digest("hex");
}

export interface RuntimeIdentity {
  version: string;
  buildId: string;
  sha256: string;
  outputReceiptSha256?: string;
}
export function runtimeIdentity(
  skill: string,
  runtime: string,
  requireProvenance = false,
): RuntimeIdentity {
  const result = exec([runtime, "build-info", "--json"]);
  if (result.code)
    throw new Error(`Pinned runtime failed build-info: ${result.stderr}`);
  const info = JSON.parse(result.stdout),
    manifest = json(join(skill, "build.json"));
  if (typeof info.version !== "string" || !/^[a-f0-9]{64}$/.test(info.buildId))
    throw new Error("Pinned runtime has malformed build identity.");
  if (info.version !== manifest.version || info.buildId !== manifest.buildId)
    throw new Error("Pinned runtime and skill build identities differ.");
  let outputReceiptSha256: string | undefined;
  if (manifest.protocol === 2) {
    if (
      [
        "version",
        "buildId",
        "revision",
        "protocol",
        "dependencies",
        "compiler",
      ].some(
        (key) => JSON.stringify(info[key]) !== JSON.stringify(manifest[key]),
      ) ||
      !manifest.dependencies?.length ||
      manifest.dependencies.some(
        (d: any) =>
          !/^[a-f0-9]{40}$/.test(d.revision) ||
          !/^[a-f0-9]{40}$/.test(d.packageTree) ||
          !/^[a-f0-9]{64}$/.test(d.sha256),
      ) ||
      manifest.compiler?.name !== "bun" ||
      manifest.recipe?.bunVersion !== manifest.compiler.version
    )
      throw new Error("Pinned runtime has incomplete build provenance.");
    const receiptFile = `${runtime}.build.json`;
    if (!existsSync(receiptFile))
      throw new Error("Pinned runtime output receipt is missing.");
    const receipt = json(receiptFile);
    if (
      receipt.schema !== "tracetoon.build-output/v1" ||
      receipt.buildId !== manifest.buildId ||
      receipt.sha256 !== hash(readFileSync(runtime)) ||
      receipt.inputManifestSha256 !==
        hash(readFileSync(join(skill, "build.json"))) ||
      receipt.compiler?.version !== manifest.compiler.version ||
      !/^[a-f0-9]{64}$/.test(receipt.compiler?.sha256) ||
      receipt.target !==
        `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
    )
      throw new Error(
        "Pinned runtime output receipt does not match its inputs or bytes.",
      );
    outputReceiptSha256 = hash(readFileSync(receiptFile));
  } else if (requireProvenance)
    throw new Error(
      "Confirmation candidates require protocol-2 build provenance and output receipts.",
    );
  return {
    version: info.version,
    buildId: info.buildId,
    sha256: hash(readFileSync(runtime)),
    ...(outputReceiptSha256 ? { outputReceiptSha256 } : {}),
  };
}

export interface Preparation {
  cases: Record<
    string,
    {
      commands?: string[][];
      fixtures?: { name: string; bundle: string; revision: string }[];
    }
  >;
}
export function prepareCase(
  sandbox: Sandbox,
  id: string,
  profile?: Preparation,
): void {
  const preparation = profile?.cases[id];
  for (const fixture of preparation?.fixtures ?? []) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(fixture.name) ||
      !/^[a-f0-9]{40}$/.test(fixture.revision)
    )
      throw new Error(
        "Fixture needs a simple sibling name and a pinned full revision.",
      );
    const target = join(dirname(sandbox.repo), fixture.name);
    if (target === sandbox.repo || existsSync(target))
      throw new Error("Fixture target already exists.");
    for (const cmd of [
      ["git", "clone", "--quiet", "--no-checkout", fixture.bundle, target],
      [
        "git",
        "-C",
        target,
        "checkout",
        "--quiet",
        "--detach",
        fixture.revision,
      ],
    ]) {
      const r = exec(cmd, { cwd: sandbox.repo, env: sandbox.env });
      if (r.code) throw new Error(`Fixture preparation failed: ${r.stderr}`);
    }
  }
  for (const command of preparation?.commands ?? []) {
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((x) => typeof x !== "string" || !x)
    )
      throw new Error("Preparation commands must be nonempty argv arrays.");
    const r = exec(command, { cwd: sandbox.repo, env: sandbox.env });
    if (r.code)
      throw new Error(
        `Preparation failed (${command[0]}): ${r.stderr.slice(-2000)}`,
      );
  }
  if (git(["diff", "--name-only", "HEAD"], sandbox.repo))
    throw new Error("Preparation changed tracked case content.");
}
