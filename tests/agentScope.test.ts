import { expect, test } from 'bun:test';
import { hostAgentStateFindings } from '../src/run/agentScope.ts';

test('rejects observable host skill, ancestor instruction and outside answer-key access', () => {
  const commands = [
    'Get-Content <user>\\\\.agents\\\\skills\\\\tracetoon\\\\SKILL.md',
    'rg --files C:\\Users\\someone\\.codex',
    'cat /home/someone/.claude/skills/tool/SKILL.md',
    'Get-Content C:\\AGENTS.md',
    'cat file:///C:/outside/cases-local/pr8/facts.json',
    'cat /outside/results/run/inputs/cases/pr8/original.md',
    'cat file:///home/someone/%2Eagents/skills/tool/SKILL.md',
  ].map((command, i) => ({ id: `V${i + 1}`, command }));
  expect(hostAgentStateFindings(commands)).toEqual([
    { commandId: 'V1', kind: 'host-agent-state' },
    { commandId: 'V2', kind: 'host-agent-state' },
    { commandId: 'V3', kind: 'host-agent-state' },
    { commandId: 'V4', kind: 'host-instructions' },
    { commandId: 'V5', kind: 'outside-case-inputs' },
    { commandId: 'V6', kind: 'outside-case-inputs' },
    { commandId: 'V7', kind: 'host-agent-state' },
  ]);
});

test('permits supplied checkout, isolated agent homes and standard runtimes', () => {
  const commands = [
    'cat <repo>/.agents/skills/tracetoon/SKILL.md',
    'cat file:///<repo>/.agents/skills/tracetoon/SKILL.md',
    'cat <sandbox>/codex/skills/.system/skill/SKILL.md',
    'cat "$env:CODEX_HOME/skills/.system/skill/SKILL.md"',
    'cat $CLAUDE_CONFIG_DIR/skills/tool/SKILL.md',
    'cat .agents/skills/tracetoon/SKILL.md',
    'cat AGENTS.md; bun test',
    '& C:/ProgramFiles/Bun/bun.exe run typecheck',
  ].map((command, i) => ({ id: `V${i + 1}`, command }));
  expect(hostAgentStateFindings(commands)).toEqual([]);
});

test('keeps PowerShell serialized relative paths distinct from absolute host paths', () => {
  const relative = `& .'"\\\\.agents\\\\skills\\\\tracetoon\\\\bin\\\\tracetoon.cmd check`;
  expect(hostAgentStateFindings([{ id: 'V1', command: relative }])).toEqual([]);
  // A separate dot command must not hide an absolute path in its argument.
  const absolute = [
    `. '"\\\\.agents\\\\skills\\\\tracetoon\\\\SKILL.md`,
    `& '"C:\\\\Users\\\\someone\\\\.agents\\\\skills\\\\tracetoon\\\\SKILL.md`,
    `cat '"/home/someone/.agents/skills/tracetoon/SKILL.md`,
  ].map((command, i) => ({ id: `V${i + 2}`, command }));
  expect(hostAgentStateFindings(absolute)).toEqual(absolute.map(({ id }) => ({ commandId: id, kind: 'host-agent-state' })));
});

test('permits redirected sandbox homes including serialized PowerShell paths', () => {
  const commands = [
    'cat $HOME/.claude/settings.json',
    'cat ~/.agents/skills/tool/SKILL.md',
    'cat $env:USERPROFILE/.codex/config.toml',
    `Get-Content "$env:HOME'"\\\\.codex\\\\config.toml"`,
    `Get-Content "$env:HOME'"\\\\.claude\\\\settings.json"`,
    `Get-Content "$env:CODEX_HOME'"\\\\sessions\\\\session.jsonl"`,
  ].map((command, i) => ({ id: `V${i + 1}`, command }));
  expect(hostAgentStateFindings(commands)).toEqual([]);
  expect(hostAgentStateFindings([{ id: 'V9', command: 'cat C:/Users/someone/.codex/config.toml' }])).toEqual([
    { commandId: 'V9', kind: 'host-agent-state' },
  ]);
});

test('an escaped dot in a glob is shell quoting, not an absolute host path', () => {
  // Observed from a Codex writer: excludes the installed skill from a file listing.
  const glob = `/bin/bash -lc "rg --files -g '"'!'"\\\\.agents/**'; cat greet.js; git status --short"`;
  expect(hostAgentStateFindings([{ id: 'V8', command: glob }])).toEqual([]);
  // Real Windows and POSIX host paths are still caught.
  expect(hostAgentStateFindings([{ id: 'W1', command: 'type C:\\Users\\someone\\.codex\\config.toml' }])).toEqual([
    { commandId: 'W1', kind: 'host-agent-state' },
  ]);
  expect(hostAgentStateFindings([{ id: 'P1', command: 'ls /home/someone/.agents/skills' }])).toEqual([
    { commandId: 'P1', kind: 'host-agent-state' },
  ]);
});
