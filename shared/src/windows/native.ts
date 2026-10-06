import { createRequire } from "node:module";
import { resolve } from "node:path";

export type NativeHandle = object;
interface WindowsNative {
  identity(): {
    sid: string;
    sessionId: number;
    home: string;
    localAppData: string;
    roots: string[];
  };
  listeningPorts(): Promise<number[]>;
  privateDirectory(path: string): void;
  fileAttributes(path: string): Promise<{ attributes: number; tag: number }>;
  renameFile(source: string, target: string, replace: boolean): Promise<void>;
  lock(path: string, shared: boolean): NativeHandle;
  closeHandle(handle: NativeHandle): void;
  jobStart(
    executable: string,
    command: string,
    cwd: string,
    environment: string,
    stdio: number[],
    privateConsole: boolean,
  ): { handle: NativeHandle; pid: number; fds: [number, number, number] };
  jobResume(handle: NativeHandle): void;
  jobInspect(handle: NativeHandle): { active: number; code?: number };
  jobTerminate(handle: NativeHandle): void;
  jobRelease(handle: NativeHandle): void;
  closeFd(fd: number): void;
  setConsoleOutputUtf8(): void;
  pipeStart(name: string): NativeHandle;
  pipePoll(handle: NativeHandle): number | undefined;
  pipeStop(handle: NativeHandle): boolean;
  pipeConnect(name: string): number | undefined;
}

let binding: WindowsNative | undefined;
export function windowsNative(): WindowsNative {
  if (process.platform !== "win32") throw new Error("Windows native API requires Windows");
  return (binding ??= createRequire(import.meta.url)(
    resolve(import.meta.dirname, "../../../dist/native/kiteline-windows.node"),
  ) as WindowsNative);
}
