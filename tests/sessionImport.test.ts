import { expect, test } from 'bun:test';
import {
  WRITES_PR_TEXT,
  assertNoPublishedPrText,
  hasUserInput,
  sliceReplaySession,
} from '../src/import/session.ts';
const at = '2026-01-01T00:00:00Z';
const from = Date.parse(at),
  to = from + 1000;
const user = (content: unknown, more = {}) => ({
  type: 'user',
  timestamp: at,
  cwd: '/repo',
  message: { role: 'user', content },
  ...more,
});
const lines = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join('\n');
const preview =
  'Please make this link clickable: file:///repo/.git/tracetoon/runs/one/out/preview.html';

test('keeps genuine user requests containing preview paths while filtering PR-writing records', () => {
  const request = user(preview);
  const writing = {
    type: 'assistant',
    timestamp: at,
    cwd: '/repo',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Write',
          input: {
            file_path: '/repo/.git/tracetoon/runs/one/body.md',
            content: 'Generated PR text',
          },
        },
      ],
    },
  };
  const result = sliceReplaySession(lines([request, writing]), from, to);
  expect(result.kept).toBe(1);
  expect(result.text).toBe(JSON.stringify(request) + '\n');
  expect(result.cwd).toBe('/repo');
});

test('handles JSON-escaped Windows preview paths in typed text blocks', () => {
  const request = user([
    {
      type: 'text',
      text: 'The preview is hard to open: C:\\repo\\.git\\tracetoon\\runs\\one\\out\\preview.html',
    },
  ]);
  expect(WRITES_PR_TEXT.test(JSON.stringify(request))).toBe(true);
  expect(sliceReplaySession(lines([request]), from, to).kept).toBe(1);
});

test.each([
  user('<task-notification>' + preview + '</task-notification>'),
  user(preview, { isMeta: true }),
  user(preview, { isCompactSummary: true }),
  user(preview, { promptSource: 'system' }),
  user([
    { type: 'tool_result', content: preview },
    { type: 'text', text: 'tool output' },
  ]),
])(
  'does not restore synthetic or tool-output records as user requests',
  (record) => {
    expect(hasUserInput(record)).toBe(false);
    expect(sliceReplaySession(lines([record]), from, to).kept).toBe(0);
  },
);

test('preserves Codex user-message formats without preserving assistant PR-writing commands', () => {
  const message = {
    type: 'response_item',
    timestamp: at,
    payload: {
      type: 'message',
      role: 'user',
      cwd: '/repo',
      content: [{ type: 'input_text', text: preview }],
    },
  };
  const event = {
    type: 'event_msg',
    timestamp: at,
    cwd: '/repo',
    payload: { type: 'user_message', message: preview },
  };
  const command = {
    type: 'response_item',
    timestamp: at,
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({
        cmd: 'gh pr create --body "Generated PR text"',
      }),
    },
  };
  expect(
    sliceReplaySession(lines([message, event, command]), from, to).kept,
  ).toBe(2);
  expect(hasUserInput(command)).toBe(false);
});

test('retains typed rejection feedback without treating ordinary tool output as user input', () => {
  const feedback = user([
    {
      type: 'tool_result',
      is_error: true,
      content: 'Tool use rejected. The user said: ' + preview,
    },
  ]);
  const output = user([
    {
      type: 'tool_result',
      is_error: false,
      content: 'The user said: ' + preview,
    },
  ]);
  expect(hasUserInput(feedback)).toBe(true);
  expect(hasUserInput(output)).toBe(false);
  expect(sliceReplaySession(lines([feedback, output]), from, to).kept).toBe(1);
});

test('retains actual asynchronous question replies as source input', () => {
  const reply = user(
    '<send_user_message_question_reply>' +
      JSON.stringify([{ answer: preview }]) +
      '</send_user_message_question_reply>',
  );
  expect(sliceReplaySession(lines([reply]), from, to).kept).toBe(1);
});

test('keeps time bounds and session metadata when preserving requests', () => {
  const metadata = { type: 'session_meta', payload: { cwd: '/repo' } };
  const late = user(preview, { timestamp: '2026-01-02T00:00:00Z' });
  const result = sliceReplaySession(
    lines([metadata, user(preview), late]) + '\nmalformed',
    from,
    to,
  );
  expect(result.kept).toBe(2);
  expect(result.cwd).toBe('/repo');
});

test('fails the answer-key leak check even for a genuine user message quoting published text', () => {
  const title = 'A distinctive published pull request title';
  const result = sliceReplaySession(
    lines([user(preview + '\n' + title)]),
    from,
    to,
  );
  expect(result.kept).toBe(1);
  expect(() =>
    assertNoPublishedPrText(result.text, title, 'Unrelated body.'),
  ).toThrow('published PR leaks');
  const opening =
    'A specific published description with enough text to identify the leaked answer.';
  expect(() =>
    assertNoPublishedPrText(lines([user(opening)]), 'Other title', opening),
  ).toThrow('published PR leaks');
});
