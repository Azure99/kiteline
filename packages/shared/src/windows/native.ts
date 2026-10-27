import { createRequire } from "node:module";
import { resolve } from "node:path";
import { nativeDirectory } from "../node/paths.js";

export type NativeHandle = object;
export type JobStdio = "pipe" | "ignore";
interface WindowsNative {
  installationDirectories(): {
    programFiles: string;
    programData: string;
  };
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
  directoryEntry(path: string): Promise<{
    attributes: number;
    tag: number;
    size: number;
    mtimeMs: number;
  }>;
  renameFile(source: string, target: string, replace: boolean): Promise<void>;
  lock(path: string): NativeHandle;
  closeHandle(handle: NativeHandle): void;
  jobStart(
    executable: string,
    command: string,
    cwd: string,
    environment: string,
    stdio: [JobStdio, JobStdio, JobStdio],
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
    resolve(nativeDirectory, "kiteline-windows.node"),
  ) as WindowsNative);
}
