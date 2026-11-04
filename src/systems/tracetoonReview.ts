/** Verify a declared review still describes the files collected for this artifact. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../util/hash.ts";
const textHash = (text: string) => digest(text.replace(/\r\n/g, "\n"));
const objectHash = (value: unknown) => textHash(JSON.stringify(value));
export function currentTracetoonReview(root: string, headSha: string): boolean {
  const text = (name: string) => readFileSync(join(root, name), "utf8");
  const read = (name: string) => JSON.parse(text(name));
  try {
    const review = read("review.json"),
      packet = read("review-input.json"),
      result = read("review-result.json");
    if (
      review.v !== 2 ||
      result.status !== "current" ||
      !/^[a-f0-9]{40}$/.test(headSha) ||
      packet.headSha !== headSha ||
      review.inputFingerprint !== packet.fingerprint ||
      result.inputFingerprint !== packet.fingerprint ||
      result.reportSha256 !== objectHash(review) ||
      packet.title !== text("title.txt").trim() ||
      packet.body !== text("final-body.md")
    )
      return false;
    if (packet.guidanceSha256 !== textHash(text("guidance.json"))) return false;
    if (
      packet.authorSha256 !==
      textHash(existsSync(join(root, "author.md")) ? text("author.md") : "")
    )
      return false;
    for (const [field, file] of [
      ["codeSourcesSha256", "source-evidence.json"],
      ["changeMapSha256", "change-map.json"],
    ])
      if (
        packet[field!] !== undefined &&
        packet[field!] !== objectHash(read(file!))
      )
        return false;
    for (const [field, file] of [
      ["digestSha256", "digest.json"],
      ["fullDigestSha256", "digest-full.json"],
    ]) {
      if (packet[field!] === undefined) continue;
      const { generatedAt: _time, ...stable } = read(file!);
      if (packet[field!] !== objectHash(stable)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
