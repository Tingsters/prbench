/** Conservative normalization of observed validation commands; never executes shell text. */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { CommandEvidence } from "../schema/validation.ts";
import { digest } from "../util/hash.ts";

function words(text: string): string[] | undefined {
  const result: string[] = [];
  let word = "",
    quote = "",
    active = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (
        quote === '"' &&
        c === "\\" &&
        ['"', "\\"].includes(text[i + 1] ?? "")
      )
        word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      active = true;
    } else if (/\s/.test(c)) {
      if (active) result.push(word);
      word = "";
      active = false;
    } else {
      word += c;
      active = true;
    }
  }
  if (quote) return;
  if (active) result.push(word);
  return result;
}

export function canonicalCheck(
  command: string,
  cwd: string,
  repo?: string,
  depth = 0,
): CommandEvidence["check"] {
  if (depth > 4)
    return { kind: "unknown", reason: "Package-script alias depth exceeded." };
  let argv = words(command);
  if (!argv?.length) return;
  if (argv[0] === "&") argv.shift();
  const program = () =>
    basename((argv?.[0] ?? "").replaceAll("\\", "/"))
      .replace(/\.(?:exe|cmd)$/i, "")
      .toLowerCase();
  if (["pwsh", "powershell", "sh", "bash"].includes(program())) {
    const at = argv.findIndex((a) =>
      ["-command", "-c", "-lc"].includes(a.toLowerCase()),
    );
    if (at < 0 || at !== argv.length - 2) return;
    argv = words(argv[at + 1]!);
    if (!argv?.length) return;
  }
  let wrapped = false;
  if (program() === "tracetoon" && argv[1] === "check") {
    const at = argv.indexOf("--");
    if (at < 0) return;
    argv = argv.slice(at + 1);
    wrapped = true;
  }
  const executable = program();
  const names =
    /^(?:test|typecheck|lint|tsc|check|format|build|bundle|eval)(?:$|:)/;
  const fileAt = argv[1] === "run" ? 2 : 1;
  const scriptFile =
    executable === "bun" &&
    /(?:^|[/\\])(?:test|typecheck|lint|check|format|build|bundle|eval)[^/\\]*\.[cm]?[jt]s$/i.test(
      argv[fileAt] ?? "",
    );
  const validation =
    executable === "bun"
      ? scriptFile ||
        names.test(argv[1] ?? "") ||
        (/^(?:run|x)$/.test(argv[1] ?? "") && names.test(argv[2] ?? ""))
      : [
          "tsc",
          "pytest",
          "vitest",
          "jest",
          "ruff",
          "mypy",
          "prettier",
          "eslint",
        ].includes(executable) ||
        (executable === "python" &&
          argv[1] === "-m" &&
          ["pytest", "unittest"].includes(argv[2] ?? "")) ||
        (["npm", "pnpm", "yarn"].includes(executable) &&
          names.test(argv[argv[1] === "run" ? 2 : 1] ?? ""));
  if (!validation) return;
  const unknown = (reason: string): NonNullable<CommandEvidence["check"]> => ({
    kind: "unknown",
    reason,
  });
  if (argv.some((a) => /[;&|<>`$\r\n]/.test(a)))
    return unknown(
      "Validation command contains shell expressions or redirections.",
    );
  let directory: string;
  if (
    cwd === "<repo>" ||
    cwd.startsWith("<repo>/") ||
    cwd.startsWith("<repo>\\")
  )
    directory = cwd.slice(6).replaceAll("\\", "/").replace(/^\//, "") || ".";
  else if (repo && !cwd.startsWith("unknown")) {
    directory = relative(repo, cwd).replaceAll("\\", "/") || ".";
    if (
      directory === ".." ||
      directory.startsWith("../") ||
      resolve(repo, directory) !== resolve(cwd)
    )
      return unknown("Validation directory is outside the observed checkout.");
  } else return unknown("Validation directory is unknown.");
  if (directory.split("/").includes(".."))
    return unknown("Validation directory is not normalized.");
  argv[0] = executable;
  let scriptSha256: string | undefined;
  if (scriptFile) {
    if (!repo) return unknown("Validation script source is unavailable.");
    const path = resolve(repo, directory, argv[fileAt]!),
      rel = relative(repo, path).replaceAll("\\", "/");
    if (rel === ".." || rel.startsWith("../") || !existsSync(path))
      return unknown(
        "Validation script is outside the checkout or unavailable.",
      );
    if (
      existsSync(join(repo, ".git")) &&
      Bun.spawnSync(["git", "-C", repo, "check-ignore", "--quiet", "--", rel], {
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode === 0
    )
      return unknown(
        "Ignored validation script is not bound by the observed content fingerprint.",
      );
    scriptSha256 = digest(readFileSync(path));
    argv = ["bun", rel, ...argv.slice(fileAt + 1)];
  }
  if (
    (!scriptFile && executable === "bun" && argv[1] === "run") ||
    ["npm", "pnpm", "yarn"].includes(executable)
  ) {
    if (!repo) return unknown("Package-script source is unavailable.");
    const path = join(repo, directory, "package.json");
    if (!existsSync(path))
      return unknown("Package-script source is unavailable.");
    let bytes: Buffer, pkg: any;
    try {
      bytes = readFileSync(path);
      pkg = JSON.parse(bytes.toString());
    } catch {
      return unknown("Package-script source could not be read.");
    }
    const nameAt = argv[1] === "run" ? 2 : 1,
      script = pkg.scripts?.[argv[nameAt]!];
    const expansion = typeof script === "string" ? words(script) : undefined;
    if (!expansion?.length || expansion.some((a) => /[;&|<>`$\r\n]/.test(a)))
      return unknown("Package script cannot be resolved as a literal command.");
    if (
      pkg.scripts?.[`pre${argv[nameAt]}`] ||
      pkg.scripts?.[`post${argv[nameAt]}`]
    )
      return unknown("Package script has lifecycle hooks.");
    const expanded = canonicalCheck(
      [...expansion, ...argv.slice(nameAt + 1)]
        .map((a) => JSON.stringify(a))
        .join(" "),
      `<repo>/${directory}`,
      repo,
      depth + 1,
    );
    if (!expanded || expanded.kind !== "check")
      return unknown(
        "Package script does not resolve directly to a supported validation command.",
      );
    argv = expanded.argv!;
    scriptSha256 = digest(
      JSON.stringify([digest(bytes), expanded.scriptSha256 ?? null]),
    );
  }
  return {
    kind: "check",
    argv,
    cwd: directory,
    ...(scriptSha256 ? { scriptSha256 } : {}),
    execution: wrapped ? "unknown" : "fresh",
  };
}

export function checkExecution(
  check: NonNullable<CommandEvidence["check"]>,
  output: string,
): NonNullable<CommandEvidence["check"]> {
  if (check.kind !== "check" || check.execution !== "unknown") return check;
  if (
    /reused unchanged inputs|"reused"\s*:\s*true|"state"\s*:\s*"reused"/.test(
      output,
    )
  )
    return { ...check, execution: "receipt-reuse" };
  if (
    /\b(?:passed|failed);\s*\d+ms\s*$/m.test(output) ||
    /"state"\s*:\s*"executed"/.test(output)
  )
    return { ...check, execution: "fresh" };
  return check;
}
