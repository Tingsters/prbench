/** Validate one selected split before starting a writer. Never loads another split's facts. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkFacts, loadFacts, type LoadedCase } from "../schema/case.ts";
import { assertNoPublishedPrText, hasUserInput } from "../import/session.ts";
import { sessionEvidence } from "../judge/evidence.ts";
import { exec } from "../util/exec.ts";
import { atomicJson, digest } from "./ledger.ts";
import { writerCaseIdentity } from "./writerInputs.ts";
export { writerCaseIdentity } from "./writerInputs.ts";

export interface FactSource {
  kind: "git" | "session" | "diff" | "commit";
  path?: string;
  revision?: string;
  startLine: number;
  endLine: number;
  sha256: string;
}
export interface FactProvenance {
  schema: "prbench.fact-provenance/v1";
  factsSha256: string;
  reviewedBy: string;
  reviewedAt: string;
  entries: Record<string, { rationale: string; sources: FactSource[] }>;
}
function casePath(loaded: LoadedCase, name: string) {
  const path = resolve(loaded.dir, name),
    rel = relative(realpathSync(loaded.dir), realpathSync(path));
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error("Case input escaped its directory.");
  return path;
}
export function preflightCase(
  loaded: LoadedCase,
  opts: { cache: string; requireProvenance?: boolean },
) {
  const facts = loadFacts(loaded);
  if (!facts || checkFacts(facts).length)
    throw new Error(`${loaded.case.id}: invalid or missing fact sheet.`);
  if (!loaded.case.repo.bundle)
    throw new Error("Preflight requires a self-contained Git bundle.");
  const bundle = casePath(loaded, loaded.case.repo.bundle),
    bundleSha = digest(readFileSync(bundle));
  const bare = join(opts.cache, `${bundleSha}.git`);
  const sourceCache = new Map<string, string>();
  const git = (args: string[]) => {
    const key = JSON.stringify(args);
    if (sourceCache.has(key)) return sourceCache.get(key)!;
    const result = exec([
      "git",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      "--git-dir",
      bare,
      ...args,
    ]);
    if (result.code)
      throw new Error(
        `${loaded.case.id}: source verification failed: ${result.stderr.slice(-500)}`,
      );
    sourceCache.set(key, result.stdout);
    return result.stdout;
  };
  if (!existsSync(bare)) {
    mkdirSync(opts.cache, { recursive: true });
    const result = exec(["git", "clone", "--mirror", "--quiet", bundle, bare]);
    if (result.code)
      throw new Error(
        `Cannot inspect case bundle: ${result.stderr.slice(-500)}`,
      );
  }
  for (const revision of [loaded.case.repo.base, loaded.case.repo.head]) {
    if (!revision || !/^[a-f0-9]{40}$/.test(revision))
      throw new Error("Comparison revisions must be full Git SHAs.");
    if (
      exec(["git", "--git-dir", bare, "cat-file", "-e", `${revision}^{commit}`])
        .code
    ) {
      // Older inspection caches may have fetched only branch heads, omitting
      // the bundle's custom base anchors. Fetch all supplied refs, never a remote.
      git(["fetch", "--quiet", bundle, "+refs/*:refs/*"]);
    }
    git(["cat-file", "-e", `${revision}^{commit}`]);
  }
  const sessions = loaded.case.sessions ?? [];
  const commitSubjects = git([
    "log",
    "--format=%s",
    `${loaded.case.repo.base}..${loaded.case.repo.head}`,
  ]).split(/\r?\n/);
  let userInputs = 0,
    sessionRecords = 0;
  for (const session of sessions) {
    const raw = readFileSync(casePath(loaded, session.file), "utf8");
    // A published title identical to an existing commit subject isn't an answer-key leak.
    if (loaded.case.original)
      assertNoPublishedPrText(
        raw,
        commitSubjects.includes(loaded.case.original.title)
          ? ""
          : loaded.case.original.title,
        readFileSync(casePath(loaded, loaded.case.original.body), "utf8"),
      );
    for (const line of raw.split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      sessionRecords++;
      if (hasUserInput(record)) userInputs++;
    }
  }
  const evidence = sessionEvidence(loaded);
  const provenanceFile = join(loaded.dir, "facts-provenance.json");
  if (
    (opts.requireProvenance ?? !loaded.case.provenance.synthetic) &&
    !existsSync(provenanceFile)
  )
    throw new Error(
      `${loaded.case.id}: facts-provenance.json is required before a comparison.`,
    );
  let checkedFacts = 0;
  if (existsSync(provenanceFile)) {
    const provenance = JSON.parse(
      readFileSync(provenanceFile, "utf8"),
    ) as FactProvenance;
    if (
      provenance.schema !== "prbench.fact-provenance/v1" ||
      provenance.factsSha256 !==
        digest(readFileSync(casePath(loaded, loaded.case.facts!))) ||
      !provenance.reviewedBy?.trim() ||
      !Number.isFinite(Date.parse(provenance.reviewedAt))
    )
      throw new Error(`${loaded.case.id}: invalid or stale fact provenance.`);
    const ids = [
      ...facts.claims.map((_, i) => `C${i + 1}`),
      ...facts.context.map((_, i) => `X${i + 1}`),
      ...facts.uncertainties.map((_, i) => `U${i + 1}`),
      ...facts.traps.map((_, i) => `T${i + 1}`),
    ];
    if (Object.keys(provenance.entries).some((id) => !ids.includes(id)))
      throw new Error("Fact provenance contains unknown fact IDs.");
    for (const id of ids) {
      const entry = provenance.entries[id];
      if (!entry?.rationale?.trim() || !entry.sources?.length)
        throw new Error(
          `${loaded.case.id}: source evidence missing for ${id}.`,
        );
      for (const source of entry.sources) {
        let content: string;
        if (
          source.kind === "session" &&
          sessions.some((s) => s.file === source.path)
        )
          content = readFileSync(casePath(loaded, source.path!), "utf8");
        else if (
          source.kind === "commit" &&
          source.revision &&
          /^[a-f0-9]{40}$/.test(source.revision)
        ) {
          git([
            "merge-base",
            "--is-ancestor",
            source.revision,
            loaded.case.repo.head!,
          ]);
          content = git([
            "show",
            "--no-patch",
            "--format=fuller",
            source.revision,
          ]);
        } else if (source.kind === "diff")
          content = git([
            "diff",
            "--no-ext-diff",
            loaded.case.repo.base,
            loaded.case.repo.head!,
          ]);
        else if (
          source.kind === "git" &&
          [loaded.case.repo.base, loaded.case.repo.head].includes(
            source.revision,
          ) &&
          source.path &&
          !source.path.includes(":") &&
          !source.path.split(/[\\/]/).includes("..")
        )
          content = git(["show", `${source.revision}:${source.path}`]);
        else throw new Error(`${loaded.case.id}: invalid source for ${id}.`);
        if (
          digest(content) !== source.sha256 ||
          !Number.isInteger(source.startLine) ||
          !Number.isInteger(source.endLine) ||
          source.startLine < 1 ||
          source.endLine < source.startLine ||
          source.endLine > content.split(/\r?\n/).length
        )
          throw new Error(
            `${loaded.case.id}: stale or invalid source range for ${id}.`,
          );
      }
      checkedFacts++;
    }
  }
  return {
    case: loaded.case.id,
    writerIdentity: writerCaseIdentity(loaded),
    factsSha256: digest(JSON.stringify(facts)),
    provenanceSha256: existsSync(provenanceFile)
      ? digest(readFileSync(provenanceFile))
      : null,
    sessionRecords,
    userInputs,
    checkedFacts,
    neutralEvidenceSha256: digest(evidence),
    neutralEvidence: evidence,
    limits: [
      ...(userInputs === 0
        ? [
            "No direct user request survives this supplied slice; tool-mediated answers and plans must retain their source attribution.",
          ]
        : []),
      "Source references establish provenance; semantic fact correctness requires the recorded review.",
      "Unavailable and truncated execution evidence remains unknown.",
    ],
  };
}
export function preflight(
  loaded: LoadedCase[],
  opts: { cache: string; out?: string; requireProvenance?: boolean },
) {
  const cases = loaded.map((l) => preflightCase(l, opts));
  const report = { schema: "prbench.preflight/v1", passed: true, cases };
  if (opts.out) atomicJson(opts.out, report);
  return report;
}
