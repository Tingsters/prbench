/** Scope acceptance is derived from a retained generation, never a new sample. */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { artifactDigest, type PRArtifact } from "../schema/artifact.ts";
import { hostAgentStateFindings } from "./agentScope.ts";
import { implementationDigest, StageCache, stageKey } from "./cache.ts";
import { atomicJson } from "./ledger.ts";

export function assertWriterScope(
  artifact: PRArtifact,
  file: string,
  experiment: string,
) {
  const audit = {
    experiment,
    artifactDigest: artifactDigest(artifact),
    contract: implementationDigest(resolve(import.meta.dir, "../.."), [
      "src/run/agentScope.ts",
    ]),
    findings: hostAgentStateFindings(artifact.validation?.commands ?? []),
  };
  const key = stageKey("scope-audit", audit);
  new StageCache(join(dirname(file), ".scope-audits")).put("audit", key, audit);
  atomicJson(file.replace(/\.json$/, ".scope-audit.json"), { key, ...audit });
  if (!audit.findings.length) return;
  const failure = file.replace(/\.json$/, ".isolation-failure.json");
  // Keep the original rejection as history even after a corrected checker passes.
  if (!existsSync(failure)) atomicJson(failure, audit);
  throw new Error(
    `Host agent state or outside case inputs were accessed: ${audit.findings.map((f) => f.commandId).join(", ")}. Preserved artifact rejected.`,
  );
}
