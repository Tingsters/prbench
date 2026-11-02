/** Slice replay inputs without treating a user's preview URL as authored PR text. */
export const WRITES_PR_TEXT =
  /tracetoon(?:\\\\|\/)+runs(?:\\\\|\/)|\bgh\s+pr\s+(?:create|edit)\b/;
const SYNTHETIC =
  /^<(?:agent-message|task-notification|system-reminder|local-command-[\w-]+|command-name|command-message|command-args|command-stdout|command-stderr|user-prompt-submit-hook|session-start-hook|environment_context)\b/i;
const COMPACT_RECAP =
  /^This session is being continued from a previous conversation that ran out of context/;
const isObject = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/** Provider-recorded user input, including typed rejection feedback and question replies. */
export function hasUserInput(value: unknown): boolean {
  if (
    !isObject(value) ||
    value.isMeta ||
    value.isCompactSummary ||
    value.isApiErrorMessage ||
    ['system', 'sdk'].includes(value.promptSource)
  )
    return false;
  let content: unknown;
  if (value.type === 'user' && isObject(value.message))
    content = value.message.content;
  else if (
    value.type === 'response_item' &&
    isObject(value.payload) &&
    value.payload.type === 'message' &&
    value.payload.role === 'user'
  )
    content = value.payload.content;
  else if (
    value.type === 'event_msg' &&
    isObject(value.payload) &&
    value.payload.type === 'user_message'
  )
    content = value.payload.message;
  else return false;
  if (
    Array.isArray(content) &&
    content.some((c) => isObject(c) && c.type === 'tool_result')
  )
    return content.some((c) => {
      if (!isObject(c) || c.type !== 'tool_result' || c.is_error !== true)
        return false;
      const output =
        typeof c.content === 'string'
          ? c.content
          : Array.isArray(c.content)
            ? c.content
                .flatMap((p) =>
                  isObject(p) && typeof p.text === 'string' ? [p.text] : [],
                )
                .join('\n')
            : '';
      const feedback = /the user said:\s*([\s\S]+)$/i.exec(output)?.[1]?.trim();
      return (
        !!feedback && !SYNTHETIC.test(feedback) && !COMPACT_RECAP.test(feedback)
      );
    });
  const text = (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((c) =>
              isObject(c) &&
              ['text', 'input_text'].includes(c.type) &&
              typeof c.text === 'string'
                ? [c.text]
                : [],
            )
            .join('\n')
        : ''
  ).trim();
  return !!text && !SYNTHETIC.test(text) && !COMPACT_RECAP.test(text);
}

/** Published text remains an answer-key leak even when it appears in a user message. */
export function assertNoPublishedPrText(
  sliceText: string,
  title: string,
  body: string,
): void {
  const escaped = (s: string) => JSON.stringify(s).slice(1, -1);
  const opening = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find((l) => l.length >= 40);
  for (const needle of [title, opening?.slice(0, 80)].filter(
    (s): s is string => !!s,
  ))
    if (sliceText.includes(escaped(needle)) || sliceText.includes(needle))
      throw new Error(
        `the published PR leaks into the session slice: "${needle.slice(0, 60)}"`,
      );
}

export function sliceReplaySession(
  text: string,
  from: number,
  to: number,
): { text: string; kept: number; cwd?: string } {
  const kept: string[] = [];
  let cwd: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(j)) continue;
    const metadata = j.type === 'session_meta';
    const at = Date.parse(j.timestamp ?? '');
    if (!metadata && !(at >= from && at <= to)) continue;
    if (WRITES_PR_TEXT.test(line) && !hasUserInput(j)) continue;
    const recordCwd = j.cwd ?? j.payload?.cwd;
    // Keep the existing discovery head-window contract for slices starting mid-session.
    if (!kept.length && !metadata && (line.length > 64 * 1024 || !recordCwd))
      continue;
    cwd ??= recordCwd;
    kept.push(line);
  }
  return { text: kept.join('\n') + '\n', kept: kept.length, cwd };
}
