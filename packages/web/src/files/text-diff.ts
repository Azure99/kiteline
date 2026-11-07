import type { Change } from "@codemirror/merge";

export async function diffText(
  before: string,
  after: string,
  signal: AbortSignal,
): Promise<readonly Change[]> {
  if (signal.aborted) throw new DOMException("Text comparison cancelled", "AbortError");
  if (before === after) return [];
  return new Promise<readonly Change[]>((resolve, reject) => {
    const worker = new Worker(new URL("./text-diff.worker.ts", import.meta.url), {
      type: "module",
    });
    function cleanup() {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    }
    function abort() {
      cleanup();
      reject(new DOMException("Text comparison cancelled", "AbortError"));
    }
    worker.onmessage = ({ data }: MessageEvent<Change[]>) => {
      cleanup();
      resolve(data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error("Could not receive the text comparison result."));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.postMessage([before, after]);
  });
}
