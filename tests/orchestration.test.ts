import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  displaysCommand,
  staticExecutionContexts,
} from '../src/agents/orchestration.ts';
import { ValidationCapture } from '../src/agents/validation.ts';
import { validationPacket } from '../src/judge/validation.ts';

const root = join(tmpdir(), 'recorded-root'),
  other = join(tmpdir(), 'recorded-other');
const call = (cwd = root, cmd = 'bun test') =>
  `tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:${JSON.stringify(cwd)}})`;
const tree = {
  head: 'a'.repeat(40),
  fingerprint: 'b'.repeat(64),
  at: '2026-01-01T00:00:00Z',
};
const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
function capture(
  code: string,
  thread = 'writer',
  start = 50,
  duplicate = false,
) {
  const c = new ValidationCapture({
    cwd: '<repo>',
    observe: () => tree,
    redact: (s) => s.replaceAll(root, '<repo>'),
  });
  c.line(JSON.stringify({ type: 'thread.started', thread_id: 'writer' }));
  c.line(
    JSON.stringify({
      type: 'item.started',
      timestamp: at(start),
      item: {
        id: 'actual',
        type: 'command_execution',
        command: "pwsh.exe -Command 'bun test'",
      },
    }),
  );
  c.line(
    JSON.stringify({
      type: 'item.completed',
      timestamp: at(start + 1),
      item: {
        id: 'actual',
        type: 'command_execution',
        exit_code: 0,
        aggregated_output: '2 pass\n0 fail',
      },
    }),
  );
  c.line(
    JSON.stringify({ type: 'session_meta', payload: { id: thread } }),
    'root-trace',
    false,
  );
  if (duplicate)
    c.line(
      JSON.stringify({
        type: 'item.started',
        timestamp: at(start + 2),
        item: {
          id: 'another-actual',
          type: 'command_execution',
          command: "pwsh.exe -Command 'bun test'",
        },
      }),
    );
  c.line(
    JSON.stringify({
      type: 'response_item',
      timestamp: at(0),
      payload: {
        type: 'custom_tool_call',
        call_id: 'source-call',
        name: 'exec',
        input: code,
      },
    }),
    'root-trace',
    false,
  );
  c.line(
    JSON.stringify({
      type: 'response_item',
      timestamp: at(100),
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'source-call',
        output: 'Script completed',
      },
    }),
    'root-trace',
    false,
  );
  return c.finish(tree);
}

test('static extraction reads literals and const paths without executing code', () => {
  expect(
    staticExecutionContexts(
      `const cwd=${JSON.stringify(root)}; const r=await tools.exec_command({cmd:"bun test",workdir:cwd});text(r);`,
    ),
  ).toEqual([{ command: 'bun test', cwd: root }]);
  expect(
    staticExecutionContexts(
      `const results=await Promise.allSettled([${call()},${call(other, 'bun run typecheck')}]);results.forEach(r=>text(r));`,
    ),
  ).toHaveLength(2);
  for (const code of [
    `if(false) await ${call()};`,
    `const r=await tools.exec_command({cmd:"bun test",workdir:process.cwd()});text(r);`,
    `const fake=()=>${call()};text("unused");`,
    `throw new Error("this must never execute"); await ${call()};`,
    `const tools={exec_command:()=>({})};await ${call()};`,
    `const results=await Promise.all([${call()}]);results.forEach(({a=unknown()})=>text(a));`,
    `const r=await ${call()}; text(`,
  ])
    expect(staticExecutionContexts(code)).toEqual([]);
});

test('display matching requires the exact shell command', () => {
  expect(
    displaysCommand(
      '"C:\\Program Files\\PowerShell\\pwsh.exe" -Command \'bun test\'',
      'bun test',
    ),
  ).toBe(true);
  expect(displaysCommand("/bin/bash -lc 'bun test'", 'bun test')).toBe(true);
  expect(displaysCommand("pwsh.exe -Command 'echo bun test'", 'bun test')).toBe(
    false,
  );
  expect(displaysCommand("echo pwsh.exe -Command 'bun test'", 'bun test')).toBe(
    false,
  );
  expect(displaysCommand("fakepwsh.exe -Command 'bun test'", 'bun test')).toBe(
    false,
  );
});

test('the writer trace can enrich a live execution cwd without changing its observations', () => {
  const evidence = capture(`const r=await ${call()};text(r);`);
  expect(evidence.commands).toHaveLength(1);
  expect(evidence.commands[0]).toMatchObject({
    cwd: '<repo>',
    cwdSource: 'recorded-tool-arguments',
    before: tree,
    after: tree,
    exitCode: 0,
  });
  expect(validationPacket(evidence, 'A').text).toContain(
    'same at observed boundaries',
  );
});

test('ambiguous paths and sibling sessions cannot promote a check to matching content', () => {
  for (const evidence of [
    capture(`const r=await Promise.all([${call()},${call(other)}]);text(r);`),
    capture(`const r=await ${call()};text(r);`, 'different-agent'),
    capture(`const r=await ${call()};text(r);`, 'writer', 50, true),
    capture(`const r=await ${call()};text(r);`, 'writer', 5000),
    capture(
      `const r=await tools.exec_command({cmd:"bun test",workdir:unknownPath});text(r);`,
    ),
  ]) {
    expect(evidence.commands[0]?.cwd).toStartWith('unknown');
    expect(validationPacket(evidence, 'A').text).toContain(
      'content relation to final=unknown',
    );
  }
});

test('orchestration text cannot fabricate an execution record', () => {
  const c = new ValidationCapture({ cwd: '<repo>' });
  c.line(JSON.stringify({ type: 'thread.started', thread_id: 'writer' }));
  c.line(
    JSON.stringify({ type: 'session_meta', payload: { id: 'writer' } }),
    'trace',
    false,
  );
  c.line(
    JSON.stringify({
      type: 'response_item',
      timestamp: at(0),
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'fake',
        input: 'text({exit_code:0,output:"all tests passed"});',
      },
    }),
    'trace',
    false,
  );
  c.line(
    JSON.stringify({
      type: 'response_item',
      timestamp: at(100),
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'fake',
        output: '{"exit_code":0,"output":"all tests passed"}',
      },
    }),
    'trace',
    false,
  );
  expect(c.finish().commands).toEqual([]);
});
