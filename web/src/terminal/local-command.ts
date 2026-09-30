import type { AgentEnvironment } from "@kiteline/shared/protocol";

export function localCommand(environment: AgentEnvironment, sessionId: string) {
  const { cliPath, runDir } = environment;
  if (environment.os !== "windows") {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const word = (value: string) => (/^[A-Za-z0-9_./-]+$/.test(value) ? value : quote(value));
    return `${word(cliPath)} attach ${word(sessionId)} --run-dir ${quote(runDir)}`;
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  return `& ${quote(cliPath)} attach ${quote(sessionId)} --run-dir ${quote(runDir)}`;
}
