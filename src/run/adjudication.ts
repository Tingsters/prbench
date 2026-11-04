import type { FactSource } from "./preflight.ts";
import { artifactDigest, type PRArtifact } from "../schema/artifact.ts";
import { digest } from "../util/hash.ts";
export interface ValidationProof {
  kind: "validation";
  artifactDigest: string;
  commandId: string;
  sha256: string;
  startLine: number;
  endLine: number;
}
export type AdjudicationSource = FactSource | ValidationProof;
export function validationSourceText(artifact: PRArtifact, id: string) {
  const command = artifact.validation?.commands.find((c) => c.id === id);
  if (!/^V[1-9]\d*$/.test(id) || !command)
    throw new Error(
      "Adjudication needs an actual captured command; V0 is a recording summary.",
    );
  return JSON.stringify(command, null, 2);
}
/** Integrity of a source is separate from the reviewer's semantic conclusion. */
export function verifyValidationProof(
  artifact: PRArtifact,
  proof: ValidationProof,
) {
  if (proof.artifactDigest !== artifactDigest(artifact))
    throw new Error("Validation proof belongs to another artifact.");
  const text = validationSourceText(artifact, proof.commandId);
  if (
    proof.sha256 !== digest(text) ||
    !Number.isInteger(proof.startLine) ||
    !Number.isInteger(proof.endLine) ||
    proof.startLine < 1 ||
    proof.endLine < proof.startLine ||
    proof.endLine > text.split(/\r?\n/).length
  )
    throw new Error("Validation source hash or range is stale or invalid.");
}
