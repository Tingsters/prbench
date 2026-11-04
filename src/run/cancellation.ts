let active: AbortSignal | undefined;
export const cancellationSignal = () => active;
export function setCancellationSignal(signal?: AbortSignal) {
  const previous = active;
  active = signal;
  return () => {
    active = previous;
  };
}
