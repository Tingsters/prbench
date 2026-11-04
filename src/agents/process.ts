import { spawnOwned } from "./ownedProcess.ts";
import { cancellationSignal } from "../run/cancellation.ts";
// A background preview can inherit the agent's output pipes. Do not wait for
// that server to exit after the actual agent process has already finished.
export async function runAgentProcess(
  cmd: string[],
  opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    prompt: string;
    timeoutMs: number;
    terminalEvent?: (line: string) => "success" | "failure" | undefined;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<{
  exitCode: number;
  rawExitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  cleanupTerminated: boolean;
  outputComplete: boolean;
}> {
  const signal = opts.signal ?? cancellationSignal();
  if (signal?.aborted)
    throw new Error("Agent invocation cancelled before launch.");
  const { proc, stop } = spawnOwned(cmd, opts);
  const abort = () => stop();
  signal?.addEventListener("abort", abort, { once: true });
  let terminal: "success" | "failure" | undefined;
  let cleanupTerminated = false;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingLine = "";
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  const text = ["", ""];
  const pumps = readers.map(async (reader, i) => {
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = decoder.decode(chunk.value, { stream: true });
      text[i] += value;
      if (i === 0) {
        pendingLine += value;
        const lines = pendingLine.split("\n");
        pendingLine = lines.pop()!;
        for (const line of lines) {
          opts.onLine?.(line);
          if (!terminal) terminal = opts.terminalEvent?.(line);
          if (terminal && !completionTimer) {
            completionTimer = setTimeout(() => {
              if (proc.exitCode === null) {
                cleanupTerminated = true;
                stop();
              }
            }, 2000);
          }
        }
      }
    }
    text[i] += decoder.decode();
    if (i === 0 && pendingLine) {
      opts.onLine?.(pendingLine);
      pendingLine = "";
    }
  });
  let readFailed = false;
  const reading = Promise.all(pumps).then(
    () => true,
    () => {
      readFailed = true;
      return true;
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.timeoutMs);
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await proc.exited;
    const drained = await Promise.race([
      reading,
      new Promise<false>((resolve) => {
        drainTimer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    if (!drained) {
      for (const reader of readers) void reader.cancel().catch(() => {});
      // Consume cancellation rejections without holding up the controller.
      void Promise.allSettled(pumps);
    }
    if (readFailed)
      throw new Error("Could not collect the agent process output.");
    return {
      exitCode: cleanupTerminated ? (terminal === "success" ? 0 : 1) : exitCode,
      rawExitCode: exitCode,
      timedOut,
      stdout: text[0]!,
      stderr: text[1]!,
      cleanupTerminated,
      outputComplete: drained,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    stop();
    clearTimeout(timer);
    clearTimeout(drainTimer);
    clearTimeout(completionTimer);
  }
}
