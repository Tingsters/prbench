/**
 * A bounded job scheduler for one comparison. Jobs become ready when their
 * dependencies finish; higher priority runs first (judges before writers, so a
 * case's results are usable as soon as its pair exists). After the first
 * failure nothing new starts, jobs already running finish and save their work,
 * and the first error is rethrown so `--resume` continues from there.
 */
export interface PoolJob {
  id: string;
  label: string;
  deps: string[];
  /** Larger runs first among ready jobs; ties keep insertion order. */
  priority: number;
  run: () => Promise<void>;
}

export interface PoolOptions {
  limit: number;
  signal?: AbortSignal;
  onStart?: (job: PoolJob) => void;
  onFinish?: (job: PoolJob, error?: unknown) => void;
}

export async function runPool(
  jobs: PoolJob[],
  opts: PoolOptions,
): Promise<void> {
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1)
    throw new Error("Parallelism must be a positive integer.");
  const ids = new Set(jobs.map((j) => j.id));
  if (ids.size !== jobs.length) throw new Error("Duplicate pool job id.");
  for (const j of jobs)
    for (const d of j.deps)
      if (!ids.has(d)) throw new Error(`Job ${j.id} depends on unknown ${d}.`);
  const done = new Set<string>();
  const pending = jobs.map((job, index) => ({ job, index }));
  const running = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;

  const ready = () =>
    pending
      .filter(({ job }) => job.deps.every((d) => done.has(d)))
      .sort((a, b) => b.job.priority - a.job.priority || a.index - b.index);

  while (pending.length || running.size) {
    const stopped = !!failure || !!opts.signal?.aborted;
    if (!stopped)
      for (const next of ready()) {
        if (running.size >= opts.limit) break;
        pending.splice(pending.indexOf(next), 1);
        const { job } = next;
        opts.onStart?.(job);
        const p: Promise<void> = job
          .run()
          .then(
            () => {
              done.add(job.id);
              opts.onFinish?.(job);
            },
            (error) => {
              failure ??= { error };
              opts.onFinish?.(job, error);
            },
          )
          .finally(() => running.delete(p));
        running.add(p);
      }
    if (!running.size) {
      if (stopped || pending.length === 0) break;
      // Nothing running and nothing ready: a dependency failed or a cycle.
      throw new Error(
        `Pool stalled with ${pending.length} job(s) whose dependencies cannot finish.`,
      );
    }
    await Promise.race(running);
  }
  if (failure) throw failure.error;
  if (opts.signal?.aborted) throw new Error("Comparison cancelled.");
}
