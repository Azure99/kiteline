let pending: Promise<unknown> = Promise.resolve();

export function publish<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const result = pending.then(() => {
    signal?.throwIfAborted();
    return action();
  });
  pending = result.catch(() => {});
  return result;
}
