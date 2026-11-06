/**
 * Who writes and who judges in a frozen comparison. A comparison runs end to
 * end on one provider: Codex writers are judged by Codex models, Claude writers
 * by Claude models. Users typically have one subscription, and mixing would
 * make a judge's preference for its own family indistinguishable from quality.
 */
import { stageKey } from "./cache.ts";
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

const CODEX: ComparisonProvider = {
  id: "codex",
  models: ["gpt-6.1-sol", "gpt-6.1-terra"],
  judges: ["codex:gpt-6.1-sol@medium", "codex:gpt-6.1-terra@medium"],
  effort: "medium",
  native: "codex-native",
  systems: ["codex-native", "tracetoon-baseline", "tracetoon-candidate"],
  command: () => codexCommand(),
  label: "Codex",
  // Byte-compatible with experiments frozen before providers existed.
  environmentHash: () =>
    stageKey(
      "writer-environment",
      Object.fromEntries(
        Object.entries(codexRunEnv(process.env)).filter(
          ([key]) =>
            ![
              "CODEX_HOME",
              ...HOME_KEYS,
              "FAKE_CODEX_JUDGMENT",
              "FAKE_CODEX_SKIP_OUTPUT_FILE",
            ].includes(key.toUpperCase()),
        ),
      ),
    ),
  authProfileHash: () => digest(codexAuthHome()),
};

/** Environment that can change what a Claude writer does, minus secrets and homes. */
function claudeComparableEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const k = key.toUpperCase();
      return (
        !HOME_KEYS.includes(k) &&
        !k.startsWith("ANTHROPIC_") &&
        !k.startsWith("CLAUDE_CODE_") &&
        !k.startsWith("CODEX_") &&
        !k.startsWith("FAKE_") &&
        !k.startsWith("PRBENCH_CLAUDE_") &&
        !k.startsWith("PRBENCH_CODEX_") &&
        !["CLAUDECODE", "OPENAI_API_KEY"].includes(k) &&
        // Shell and launcher bookkeeping: where the command was typed from,
        // not anything a writer sees (each runs in its own sandbox cwd).
        !["PWD", "OLDPWD", "INIT_CWD", "SHLVL", "_"].includes(k) &&
        !k.startsWith("NPM_")
      );
    }),
  );
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
  environmentHash: () =>
    stageKey("writer-environment", { claude: claudeComparableEnv() }),
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
