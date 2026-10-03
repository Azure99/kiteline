import { agentConfig, agentPaths, defaultAgentLimits } from "../config.js";
import { diagnose, type DoctorReport } from "../doctor.js";
import { localRequest } from "../local.js";

export async function doctorCli() {
  const config = { ...(await agentPaths()), limits: defaultAgentLimits };
  let report: DoctorReport;
  try {
    report = await localRequest<DoctorReport>(config, "doctor");
  } catch (error) {
    report = await diagnose(config, AbortSignal.timeout(config.limits.rpcTimeout));
    try {
      await agentConfig();
    } catch (error) {
      report.items.push({
        name: "Configuration on disk",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    report.items.unshift({
      name: "Local connection",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  for (const item of report.items) console.log(`[${item.status}] ${item.name}: ${item.detail}`);
  if (report.items.some((item) => item.status === "error")) process.exitCode = 1;
}
