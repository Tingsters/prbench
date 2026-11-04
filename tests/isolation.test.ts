import { expect, test } from 'bun:test';
import {
  assertSkillIsolation,
  inspectSkillCatalogue,
} from '../src/run/isolation.ts';

const message = (text: string) =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ text }] },
  });
const catalog = (path?: string) =>
  '### Skill roots\n- `r2` = `/sandbox/repo/.agents/skills`\n### Available skills\n' +
  (path
    ? `- tracetoon: A PR skill. (file: ${path})`
    : '- other: An unrelated skill. (file: /other/SKILL.md)');

test('catalogue inspection resolves aliases and rejects leaked or duplicate global skills', () => {
  const local = '/sandbox/repo/.agents/skills/tracetoon/SKILL.md';
  const observed = inspectSkillCatalogue([
    message(catalog('r2/tracetoon/SKILL.md')),
  ]);
  expect(observed.paths).toEqual([local]);
  expect(() => assertSkillIsolation(observed, local, local)).not.toThrow();
  expect(() => assertSkillIsolation(observed, 'NONE')).toThrow(
    'isolation failed',
  );
  const both = inspectSkillCatalogue([
    message(
      catalog(local) +
        '\n- tracetoon: Global. (file: /host/skills/tracetoon/SKILL.md)',
    ),
  ]);
  expect(() => assertSkillIsolation(both, local, local)).toThrow(
    'isolation failed',
  );
});

test('native absence needs a real startup catalogue, not a self-reported NONE', () => {
  expect(() =>
    assertSkillIsolation(inspectSkillCatalogue([message(catalog())]), 'NONE'),
  ).not.toThrow();
  expect(() => assertSkillIsolation(inspectSkillCatalogue([]), 'NONE')).toThrow(
    'captured startup catalogue',
  );
  expect(() =>
    assertSkillIsolation(
      inspectSkillCatalogue([message(catalog())]),
      '/host/tracetoon/SKILL.md',
    ),
  ).toThrow('isolation failed');
});

test('even a non-shell tool call invalidates the no-tool isolation probe', () => {
  const event = JSON.stringify({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'some_tool' },
  });
  const observed = inspectSkillCatalogue([message(catalog()), event]);
  expect(observed.toolCalls).toBe(1);
  expect(() => assertSkillIsolation(observed, 'NONE')).toThrow('no tool calls');
});
