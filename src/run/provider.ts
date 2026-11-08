/**
 * Who writes and who judges in a frozen comparison. A comparison runs end to
 * end on one provider: Codex writers are judged by Codex models, Claude writers
 * by Claude models. Users typically have one subscription, and mixing would
 * make a judge's preference for its own family indistinguishable from quality.
 */
import { stageKey } from "./cache.ts";
import { VOLATILE_ENV, VOLATILE_PREFIXES } from "./sandbox.ts";
import { digest } from "../util/hash.ts";
import {
  codexAuthHome,
  codexCommand,
  codexRunEnv,
} from "../agents/codexAuth.ts";
import { claudeAuthStatus, claudeCommand } from "../agents/claude.ts";

export type ProviderId = "codex" | "claude";
export const PROVIDERS: ProviderId[] = ["codex", "claude"];

export interface ComparisonProvider {
  id: ProviderId;
  /** Writer models; the same models judge. */
  models: string[];
  judges: string[];
  effort: string;
  /** The system that writes without Tracetoon. */
  native: string;
  /** Writer systems in canonical order (rotation starts here). */
  systems: string[];
  command(): string[];
  label: string;
  environmentHash(): string;
  /**
   * The hash before shell and session bookkeeping was excluded. An experiment
   * frozen with it keeps it on resume from the same shell, so its identity and
   * writer keys don't change.
   */
  legacyEnvironmentHash(): string;
  authProfileHash(): string;
}

const HOME_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

/**
 * Shell, terminal and session bookkeeping on top of VOLATILE_ENV: where and
 * from which window or session a command was typed. It differs between shells
 * launching the same experiment and never changes what a writer does, so it is
 * left out of the writer environment identity. Variables that can change a
 * writer (PATH, TMPDIR, LANG, provider settings, tool configuration) stay in.
 */
export const SHELL_VOLATILE_ENV = [
  ...VOLATILE_ENV,
  "PWD",
  "OLDPWD",
  "INIT_CWD",
  "SHLVL",
  "_",
  "CLAUDECODE",
  "TERM_SESSION_ID",
  "TERM_PROGRAM_VERSION",
  "ITERM_SESSION_ID",
  "ITERM_PROFILE",
  "WINDOWID",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "SSH_TTY",
  "COLUMNS",
  "LINES",
  "XAUTHORITY",
  "DESKTOP_STARTUP_ID",
  "XDG_ACTIVATION_TOKEN",
  "GNOME_TERMINAL_SCREEN",
  "GNOME_TERMINAL_SERVICE",
  "KITTY_WINDOW_ID",
  "KITTY_PID",
  "KITTY_LISTEN_ON",
  "ALACRITTY_WINDOW_ID",
  "ALACRITTY_SOCKET",
  "ALACRITTY_LOG",
  "WEZTERM_PANE",
  "WEZTERM_UNIX_SOCKET",
  "SECURITYSESSIONID",
  "__CFBUNDLEIDENTIFIER",
  "TERMINAL_EMULATOR",
];
export const SHELL_VOLATILE_PREFIXES = [
  ...VOLATILE_PREFIXES,
  "VSCODE_",
  "ZED_",
  "GHOSTTY_",
  "PRBENCH_SHELL_",
];

export function isShellVolatile(key: string): boolean {
  const k = key.toUpperCase();
  return (
    SHELL_VOLATILE_ENV.includes(k) ||
    SHELL_VOLATILE_PREFIXES.some((p) => k.startsWith(p))
  );
}

/**
 * Harness controls that never reach a writer (sandbox.ts drops them): the
 * timeouts are recorded in the manifest where they matter, so setting them in
 * the environment must not change the writer environment identity.
 */
export const HARNESS_CONTROL_ENV = [
  "PRBENCH_JUDGE_TIMEOUT_MS",
  "PRBENCH_WRITER_TIMEOUT_MS",
  "PRBENCH_PREFLIGHT_CACHE",
];

const CODEX_HASH_EXCLUDED = [
  ...HARNESS_CONTROL_ENV,
  "CODEX_HOME",
  ...HOME_KEYS,
  "FAKE_CODEX_JUDGMENT",
  "FAKE_CODEX_SKIP_OUTPUT_FILE",
];
function codexComparableEnv(
  env: Record<string, string | undefined>,
  dropVolatile: boolean,
) {
  return Object.fromEntries(
    Object.entries(codexRunEnv(env)).filter(
      ([key]) =>
        !CODEX_HASH_EXCLUDED.includes(key.toUpperCase()) &&
        !(dropVolatile && isShellVolatile(key)),
    ),
  );
}

/** Writer environment identity for Codex comparisons, without shell and session bookkeeping. */
export function codexEnvironmentHash(
  env: Record<string, string | undefined> = process.env,
): string {
  return stageKey("writer-environment", codexComparableEnv(env, true));
}

const CODEX: ComparisonProvider = {
  id: "codex",
  models: ["gpt-6.1-sol", "gpt-6.1-terra"],
  judges: ["codex:gpt-6.1-sol@medium", "codex:gpt-6.1-terra@medium"],
  effort: "medium",
  native: "codex-native",
  systems: ["codex-native", "tracetoon-baseline", "tracetoon-candidate"],
  command: () => codexCommand(),
  label: "Codex",
  environmentHash: () => codexEnvironmentHash(),
  // Byte-compatible with experiments frozen before providers existed.
  legacyEnvironmentHash: () =>
    stageKey("writer-environment", codexComparableEnv(process.env, false)),
  authProfileHash: () => digest(codexAuthHome()),
};

/** Environment that can change what a Claude writer does, minus secrets and homes. */
function claudeComparableEnv(
  env: Record<string, string | undefined> = process.env,
  dropVolatile = true,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const k = key.toUpperCase();
      return (
        !HOME_KEYS.includes(k) &&
        !HARNESS_CONTROL_ENV.includes(k) &&
        !k.startsWith("ANTHROPIC_") &&
        !k.startsWith("CLAUDE_CODE_") &&
        // Never passed to writers (sandbox.ts drops them): shell and session bookkeeping.
        !VOLATILE_ENV.includes(k) &&
        !VOLATILE_PREFIXES.some((p) => k.startsWith(p)) &&
        !k.startsWith("CODEX_") &&
        !k.startsWith("FAKE_") &&
        !k.startsWith("PRBENCH_CLAUDE_") &&
        !k.startsWith("PRBENCH_CODEX_") &&
        !["CLAUDECODE", "OPENAI_API_KEY"].includes(k) &&
        // Shell and launcher bookkeeping: where the command was typed from,
        // not anything a writer sees (each runs in its own sandbox cwd).
        !["PWD", "OLDPWD", "INIT_CWD", "SHLVL", "_"].includes(k) &&
        !k.startsWith("NPM_") &&
        !(dropVolatile && isShellVolatile(k))
      );
    }),
  );
}

/** Writer environment identity for Claude comparisons, without shell and session bookkeeping. */
export function claudeEnvironmentHash(
  env: Record<string, string | undefined> = process.env,
): string {
  return stageKey("writer-environment", { claude: claudeComparableEnv(env) });
}

const CLAUDE: ComparisonProvider = {
  id: "claude",
  models: ["claude-opus-5-5", "claude-sonnet-5-5"],
  judges: ["claude:claude-opus-5-5@medium", "claude:claude-sonnet-5-5@medium"],
  effort: "medium",
  native: "claude-native",
  systems: ["claude-native", "tracetoon-baseline", "tracetoon-candidate"],
  command: () => claudeCommand(),
  label: "Claude",
  environmentHash: () => claudeEnvironmentHash(),
  legacyEnvironmentHash: () =>
    stageKey("writer-environment", {
      claude: claudeComparableEnv(process.env, false),
    }),
  // Which credential source is used, never the credential itself.
  authProfileHash: () => digest(`claude:${claudeAuthStatus().source}`),
};

export function comparisonProvider(id: string | undefined): ComparisonProvider {
  if (id === undefined || id === "codex") return CODEX;
  if (id === "claude") return CLAUDE;
  throw new Error(`Unknown provider ${id}; use codex or claude.`);
}

/** Manifests frozen before providers existed are Codex comparisons. */
export function manifestProvider(settings: {
  provider?: string;
}): ComparisonProvider {
  return comparisonProvider(settings.provider);
}

/** Which manifest artifact a Tracetoon system's frozen skill comes from. */
export function skillInput(
  system: string,
): "baseline" | "candidate" | undefined {
  if (system === "tracetoon-baseline") return "baseline";
  if (system === "tracetoon-candidate") return "candidate";
  return undefined;
}

const SYSTEM_ALIASES: Record<string, "native" | "baseline" | "candidate"> = {
  native: "native",
  baseline: "baseline",
  "tracetoon-baseline": "baseline",
  candidate: "candidate",
  "tracetoon-candidate": "candidate",
};

/**
 * Writer systems for one run, in the provider's canonical order. Accepts
 * `native`, `baseline`, `candidate`, the full Tracetoon names and the
 * provider's native name. Omitted means all three. Candidate and baseline are
 * always required: the baseline pairing is the primary comparison.
 */
export function selectSystems(
  provider: ComparisonProvider,
  names?: string[],
): string[] {
  if (!names?.length) return [...provider.systems];
  const wanted = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    const role =
      name === provider.native ? "native" : SYSTEM_ALIASES[name];
    if (!role)
      throw new Error(
        `Unknown system ${name}; use native, baseline or candidate (or ${provider.systems.join(", ")}).`,
      );
    wanted.add(
      role === "native"
        ? provider.native
        : role === "baseline"
          ? "tracetoon-baseline"
          : "tracetoon-candidate",
    );
  }
  if (!wanted.has("tracetoon-candidate") || !wanted.has("tracetoon-baseline"))
    throw new Error(
      "--systems needs at least baseline and candidate (native is optional).",
    );
  return provider.systems.filter((s) => wanted.has(s));
}

/** Manifests without `systems` ran all of the provider's systems. */
export function manifestSystems(
  settings: { systems?: string[] },
  provider: ComparisonProvider,
): string[] {
  return settings.systems ?? [...provider.systems];
}

/** Systems the candidate is judged against, in report order. */
export function judgedAgainst(
  systems: string[],
  provider: ComparisonProvider,
): string[] {
  return ["tracetoon-baseline", provider.native].filter((s) =>
    systems.includes(s),
  );
}
