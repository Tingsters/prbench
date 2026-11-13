import { expect, test } from "bun:test";
import { writerEnvironmentHash } from "../src/comparison.ts";
import { claudeEnvironmentHash, codexEnvironmentHash } from "../src/run/provider.ts";

const base = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/a",
  TMPDIR: "/var/tmp",
  LANG: "en_US.UTF-8",
  OPENAI_BASE_URL: "https://example.invalid",
  SHLVL: "1",
  _: "/usr/bin/bun",
  PWD: "/home/a/prbench",
  OLDPWD: "/home/a",
  TERM_SESSION_ID: "w0t0p0:AAAA",
  CLAUDECODE: "1",
  CLAUDE_CODE_SSE_PORT: "1234",
  CLAUDE_PID: "11",
  KONSOLE_DBUS_WINDOW: "/Windows/1",
  WINDOWID: "1",
  TMUX_PANE: "%1",
  VSCODE_IPC_HOOK_CLI: "/run/user/1/vscode-a.sock",
  INVOCATION_ID: "x",
};
const otherShell = {
  ...base,
  SHLVL: "4",
  _: "/usr/bin/env",
  PWD: "/var/home/a/elsewhere",
  OLDPWD: "/tmp",
  TERM_SESSION_ID: "w1t2p0:BBBB",
  CLAUDE_CODE_SSE_PORT: "9999",
  CLAUDE_PID: "77",
  KONSOLE_DBUS_WINDOW: "/Windows/7",
  WINDOWID: "9",
  TMUX_PANE: "%7",
  VSCODE_IPC_HOOK_CLI: "/run/user/1/vscode-b.sock",
  INVOCATION_ID: "y",
};
const { CLAUDECODE: _drop, TERM_SESSION_ID: _drop2, ...noSession } = base;

for (const [name, hash] of [
  ["Codex", codexEnvironmentHash],
  ["Claude", claudeEnvironmentHash],
] as const)
  test(`${name} writer environment identity ignores shell and session bookkeeping`, () => {
    expect(hash(otherShell)).toBe(hash(base));
    expect(hash(noSession)).toBe(hash(base));
    // Variables that can change what a writer does still count.
    expect(hash({ ...base, PATH: "/opt/bin:/usr/bin:/bin" })).not.toBe(hash(base));
    expect(hash({ ...base, TMPDIR: "/tmp" })).not.toBe(hash(base));
    expect(hash({ ...base, SOME_TOOL_SETTING: "on" })).not.toBe(hash(base));
  });

test("an experiment frozen with the legacy hash keeps it while it still matches", () => {
  const provider = { environmentHash: () => "new", legacyEnvironmentHash: () => "old" };
  const frozen = (h: string) => ({ settings: { toolchain: { environmentHash: h } } }) as never;
  expect(writerEnvironmentHash(provider)).toBe("new");
  expect(writerEnvironmentHash(provider, frozen("old"))).toBe("old");
  expect(writerEnvironmentHash(provider, frozen("new"))).toBe("new");
  expect(writerEnvironmentHash(provider, undefined, frozen("old"))).toBe("old");
  // A different shell (neither hash matches) gets the new, shell-independent identity.
  expect(writerEnvironmentHash(provider, frozen("other"))).toBe("new");
});
