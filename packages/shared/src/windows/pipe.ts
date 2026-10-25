import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { windowsNative, type NativeHandle } from "./native.js";

function socket(fd: number) {
  try {
    return new Socket({ fd, readable: true, writable: true });
  } catch (error) {
    windowsNative().closeFd(fd);
    throw error;
  }
}

export class PrivatePipe {
  private readonly handle: NativeHandle;
  private readonly timer: NodeJS.Timeout;
  private closing?: Promise<void>;
  constructor(name: string, accept: (socket: Socket) => void, failed: (error: unknown) => void) {
    const native = windowsNative();
    this.handle = native.pipeStart(name);
    this.timer = setInterval(() => {
      try {
        const fd = native.pipePoll(this.handle);
        if (fd !== undefined) {
          const connection = socket(fd);
          try {
            accept(connection);
          } catch (error) {
            connection.destroy();
            throw error;
          }
        }
      } catch (error) {
        clearInterval(this.timer);
        void this.close().then(
          () => failed(error),
          (cleanupError: unknown) =>
            failed(new AggregateError([error, cleanupError], "Private pipe and cleanup failed")),
        );
      }
    }, 10);
  }
  close() {
    return (this.closing ??= (async () => {
      clearInterval(this.timer);
      while (!windowsNative().pipeStop(this.handle)) await delay(10);
    })());
  }
}

export async function connectPrivatePipe(name: string, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    const fd = windowsNative().pipeConnect(name);
    if (fd !== undefined) return socket(fd);
    await delay(10, undefined, { signal });
  }
}
