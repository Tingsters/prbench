/**
 * `compare --provider both`: two independent end-to-end comparisons, one per
 * provider, run as separate processes so each keeps its own manifest,
 * controller lock, cancellation and report. They never share judges.
 */
import { join } from "node:path";
import { PROVIDERS } from "./provider.ts";

/** Replace or drop `--name value` / `--name=value` options in an argv list. */
export function rewriteOption(
  argv: string[],
  name: string,
  value: string | undefined,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === name) {
      i++;
      continue;
    }
    if (arg.startsWith(`${name}=`)) continue;
    out.push(arg);
  }
  return value === undefined ? out : [...out, name, value];
}

export function optionValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i]!.startsWith(`${name}=`)) return argv[i]!.slice(name.length + 1);
  }
  return undefined;
}

/** Arguments for one provider's child process. */
export function providerArgs(argv: string[], provider: string): string[] {
  let args = rewriteOption(argv, "--provider", provider);
  const out = optionValue(argv, "--out");
  if (!out) throw new Error("compare needs --out.");
  args = rewriteOption(args, "--out", join(out, provider));
  // A both-provider development or reuse source holds one run per provider.
  for (const name of ["--development", "--reuse-from"]) {
    const dir = optionValue(argv, name);
    if (dir) args = rewriteOption(args, name, join(dir, provider));
  }
  return args;
}

async function pipe(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  sink: NodeJS.WriteStream,
) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop()!;
    for (const line of lines) sink.write(`${prefix}${line}\n`);
  }
  if (rest) sink.write(`${prefix}${rest}\n`);
}

export async function runBothProviders(argv: string[]): Promise<number> {
  const script = process.argv[1]!;
  const children = PROVIDERS.map((provider) => {
    const proc = Bun.spawn(
      [process.execPath, script, ...providerArgs(argv, provider)],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env },
    );
    return {
      provider,
      proc,
      done: Promise.all([
        pipe(proc.stdout, `[${provider}] `, process.stdout),
        pipe(proc.stderr, `[${provider}] `, process.stderr),
        proc.exited,
      ]),
    };
  });
  const forward = (signal: NodeJS.Signals) => () => {
    for (const c of children) c.proc.kill(signal);
  };
  const onInt = forward("SIGINT"),
    onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    await Promise.all(children.map((c) => c.done));
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  const codes = children.map((c) => ({
    provider: c.provider,
    exitCode: c.proc.exitCode ?? 1,
  }));
  for (const c of codes)
    console.log(`[both] ${c.provider}: exit ${c.exitCode}`);
  // The worst outcome wins: any invalid run (2) outranks a failed gate (1).
  return Math.max(...codes.map((c) => c.exitCode));
}
