import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedCase } from "../schema/case.ts";
import { digest } from "../util/hash.ts";
import { stageKey } from "./cache.ts";
export function writerCaseIdentity(loaded: LoadedCase) {
  const {
    facts: _facts,
    original: _original,
    provenance: _provenance,
    ...writer
  } = loaded.case;
  return stageKey("writer-case", {
    case: writer,
    files: [
      loaded.case.repo.bundle!,
      ...(loaded.case.sessions ?? []).map((s) => s.file),
    ].map((file) => [file, digest(readFileSync(join(loaded.dir, file)))]),
  });
}
