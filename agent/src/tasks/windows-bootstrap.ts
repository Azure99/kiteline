import { spawn } from "node:child_process";
import { windowsNative } from "@kiteline/shared/windows/native";

// Initialize the task's private console before PowerShell creates its output writers.
windowsNative().setConsoleOutputUtf8();
const child = spawn(process.argv[3]!, process.argv.slice(4), {
  stdio: "inherit",
  env: { ...process.env, ...JSON.parse(process.argv[2]!) },
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
