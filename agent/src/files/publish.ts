let publishing = false;
const waiting = new Set<() => void>();

export function publish<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      waiting.delete(start);
      reject(signal!.reason);
    };
    const start = () => {
      publishing = true;
      signal?.removeEventListener("abort", cancel);
      void Promise.resolve()
        .then(() => {
          signal?.throwIfAborted();
          return action();
        })
        .then(resolve, reject)
        .finally(() => {
          publishing = false;
          const next = waiting.values().next().value;
          if (next) {
            waiting.delete(next);
            next();
          }
        });
    };
    if (signal?.aborted) return cancel();
    if (publishing) {
      waiting.add(start);
      signal?.addEventListener("abort", cancel, { once: true });
    } else start();
  });
}
