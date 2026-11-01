// Removes what would let a judge tell systems apart without reading the
// content: tool markers, comics, attribution footers. What is left is what a
// reviewer would read as the description.

const LINE_PATTERNS: RegExp[] = [
  /^\s*<sub>\s*Assisted-by:.*<\/sub>\s*$/i,
  /^\s*🤖\s*Generated with \[?Claude Code\]?.*$/i,
  /^\s*Generated with \[Claude Code\]\(.*\)\s*$/i,
  /^\s*(?:🤖\s*)?Generated with \[?Codex\]?.*$/i,
  /^\s*(?:This\s+)?(?:PR\s+)?description\s+(?:was\s+)?(?:prepared|drafted|written|generated)\b.*(?:\b(?:AI|Codex|Claude|Tracetoon)\b|\bsession logs\b).*$/i,
  /^\s*(?:Implementation|Code)\s+(?:was\s+)?(?:assisted|prepared|drafted|written|generated)\s+(?:by|with)\b.*\b(?:AI|Codex|Claude|Tracetoon)\b.*$/i,
  /^\s*No human (?:author )?review (?:was|has been) (?:captured|recorded|claimed)[.!]?\s*$/i,
  /^\s*Co-Authored-By:.*$/i,
  /^\s*Assisted-by:.*$/i,
];

export function normalizeBody(body: string): string {
  let text = body.replace(/\r\n/g, '\n');
  // HTML comments, e.g. tool markers and metadata.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Embedded images (comics, screenshots of tool output) and their transcripts.
  text = text.replace(/<p[^>]*>\s*<img[^>]*>\s*<\/p>/gi, '');
  text = text.replace(/<img[^>]*>/gi, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/<details>\s*<summary>\s*Comic transcript\s*<\/summary>[\s\S]*?<\/details>/gi, '');
  text = text
    .split('\n')
    .map((line) => line.split(/(?<=[.!?])\s+(?=[A-Z`])/).filter((sentence) => {
      // Mixed attribution/validation lines used to lose accurate check results.
      // Keep substantive statements even when the attribution isn't separable.
      if (/\b(?:tests?|checks?|validation|passed|failed|build|typecheck|lint|suite|errors?|dependencies|timeout)\b/i.test(sentence)) return true;
      return !LINE_PATTERNS.some((p) => p.test(sentence));
    }).join(' '))
    .join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
