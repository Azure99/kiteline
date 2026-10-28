import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AppError, record, string } from "@kiteline/shared/protocol";
import { atomicJson, readJson } from "@kiteline/shared/node/files";
import type { SessionSelection, TargetSelection, WorkspaceSelection } from "./options.js";

export interface Credentials {
  server: string;
  token: string;
}

export function serverOrigin(value: unknown) {
  let url: URL;
  try {
    url = new URL(string(value, "server origin"));
  } catch {
    throw new AppError("invalid_argument", "Server must be an HTTP or HTTPS origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new AppError(
      "invalid_argument",
      "Server must be an HTTP or HTTPS origin without a path or credentials",
    );
  return url.origin;
}

function credentialsDirectory() {
  return resolve(process.env.KITELINE_CLI_HOME ?? resolve(homedir(), ".kiteline"));
}

async function jsonFile(path: string) {
  try {
    return record(await readJson(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError)
      throw new AppError("invalid_argument", `Invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

export async function credentials() {
  const url = process.env.KITELINE_URL;
  const token = process.env.KITELINE_TOKEN;
  if (url !== undefined || token !== undefined) {
    if (!url || !token)
      throw new AppError("invalid_argument", "Set KITELINE_URL and KITELINE_TOKEN together");
    return {
      server: serverOrigin(url),
      token: string(token, "token"),
      source: "environment" as const,
    };
  }
  const path = resolve(credentialsDirectory(), "credentials.json");
  const saved = await jsonFile(path);
  if (!saved)
    throw new AppError(
      "unauthenticated",
      "No CLI credentials. Use auth login --server ORIGIN, or set KITELINE_URL and KITELINE_TOKEN together.",
    );
  return {
    server: serverOrigin(saved.server),
    token: string(saved.token, "token"),
    source: "file" as const,
    path,
  };
}

export async function saveCredentials(value: Credentials) {
  const directory = credentialsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicJson(resolve(directory, "credentials.json"), value);
}

export async function removeCredentials(value: Awaited<ReturnType<typeof credentials>>) {
  if (value.source === "file") await rm(value.path, { force: true });
}

interface WorkspaceTarget {
  deviceId: string;
  workspaceId: string;
}
interface SessionTarget extends WorkspaceTarget {
  sessionId: string;
}

export function target(selection: SessionSelection): Promise<SessionTarget>;
export function target(selection: WorkspaceSelection): Promise<WorkspaceTarget>;
export async function target(selection: TargetSelection): Promise<WorkspaceTarget | SessionTarget> {
  const saved = (await jsonFile(resolve(process.cwd(), ".kiteline.json"))) ?? {};
  const deviceId = string(
    selection.device ?? saved.device,
    "device: use --device or cwd .kiteline.json",
  );
  const workspaceId = string(
    selection.workspace ?? saved.workspace,
    "workspace: use --workspace or cwd .kiteline.json",
  );
  if (selection.kind === "session")
    return {
      deviceId,
      workspaceId,
      sessionId: string(
        selection.session ?? saved.session,
        "session: use --session or cwd .kiteline.json",
      ),
    };
  return { deviceId, workspaceId };
}
