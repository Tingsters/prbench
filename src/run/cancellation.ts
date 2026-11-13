let active: AbortSignal | undefined;
export const cancellationSignal = () => active;
export function setCancellationSignal(signal?: AbortSignal) {
  const previous = active;
  active = signal;
  return () => {
    active = previous;
  };
}

/** A retry wait that a cancelled comparison does not sit through. */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) return resolveSleep();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveSleep();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
