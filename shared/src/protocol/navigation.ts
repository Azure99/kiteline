export type WorkspaceTool = "terminal" | "files" | "git";
export interface WorkspaceQuery {
  session?: string;
  repo?: string;
  file?: string;
  draft?: string;
  folder?: string;
  reveal?: string;
  search?: boolean;
}
export function devicePath(deviceId: string) {
  return `/devices/${encodeURIComponent(deviceId)}`;
}
export function workspacePath(
  deviceId: string,
  workspaceId: string,
  tool: WorkspaceTool = "terminal",
  query: WorkspaceQuery = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === false || (key === "folder" && value === ".")) continue;
    params.set(key, value === true ? "1" : value);
  }
  const search = params.toString();
  return `${devicePath(deviceId)}/workspaces/${encodeURIComponent(workspaceId)}/${tool}${search ? `?${search}` : ""}`;
}
