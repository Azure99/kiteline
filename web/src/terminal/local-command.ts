import type { AgentEnvironment } from "@kiteline/shared/protocol";

export function localCommand(environment: AgentEnvironment, sessionId: string) {
  const { cliPath, dataDir, runDir } = environment;
  if (environment.os !== "windows") {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    return `KITELINE_AGENT_HOME=${quote(dataDir)} KITELINE_AGENT_RUN_DIR=${quote(runDir)} ${quote(cliPath)} terminal attach ${quote(sessionId)}`;
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  return `& { $kitelineHome = [Environment]::GetEnvironmentVariable('KITELINE_AGENT_HOME', 'Process'); $kitelineRun = [Environment]::GetEnvironmentVariable('KITELINE_AGENT_RUN_DIR', 'Process'); try { $env:KITELINE_AGENT_HOME = ${quote(dataDir)}; $env:KITELINE_AGENT_RUN_DIR = ${quote(runDir)}; & ${quote(cliPath)} terminal attach ${quote(sessionId)} } finally { if ($null -eq $kitelineHome) { Remove-Item Env:KITELINE_AGENT_HOME -ErrorAction SilentlyContinue } else { $env:KITELINE_AGENT_HOME = $kitelineHome }; if ($null -eq $kitelineRun) { Remove-Item Env:KITELINE_AGENT_RUN_DIR -ErrorAction SilentlyContinue } else { $env:KITELINE_AGENT_RUN_DIR = $kitelineRun } } }`;
}
