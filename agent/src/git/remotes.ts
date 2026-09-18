import {
  AppError,
  limits,
  type GitRemotes,
  type HeadIdentity,
  type Repo,
} from "@kiteline/shared/protocol";
import { commandLine, git, utf8 } from "./process.js";
import { headIdentity } from "./status.js";

async function config(repo: Repo, name: string, signal: AbortSignal) {
  const result = await git(repo.rootPath, ["config", "--null", "--get-all", name], signal, {
    allowedCodes: [0, 1],
  });
  return result.code === 0 ? utf8(result.bytes).split("\0").slice(0, -1) : [];
}
export async function remotes(repo: Repo, signal: AbortSignal): Promise<GitRemotes> {
  const result = await git(
    repo.rootPath,
    ["config", "--null", "--get-regexp", "^remote\\."],
    signal,
    { allowedCodes: [0, 1] },
  );
  const entries = new Map<string, { name: string; fetchUrls: string[]; pushUrls: string[] }>();
  const explicitPush = new Set<string>();
  for (const record of utf8(result.bytes).split("\0").slice(0, -1)) {
    const newline = record.indexOf("\n");
    const key = record.slice(0, newline < 0 ? undefined : newline);
    const value = newline < 0 ? "" : record.slice(newline + 1);
    const dot = key.lastIndexOf(".");
    if (dot <= 7) continue;
    const name = key.slice(7, dot),
      setting = key.slice(dot + 1);
    let entry = entries.get(name);
    if (!entry) entries.set(name, (entry = { name, fetchUrls: [], pushUrls: [] }));
    if (setting === "url") entry.fetchUrls.push(value);
    if (setting === "pushurl") entry.pushUrls.push(value);
    if (setting === "push" || setting === "mirror") explicitPush.add(name);
  }
  for (const entry of entries.values()) {
    const fetchCount = entry.fetchUrls.length;
    const pushCount = entry.pushUrls.length || fetchCount;
    for (const push of [false, true]) {
      const count = push ? pushCount : fetchCount;
      if (!count) continue;
      const urls = await git(
        repo.rootPath,
        ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "--", entry.name],
        signal,
      );
      const text = commandLine(urls.bytes);
      const values = count === 1 ? [text] : text.split("\n");
      if (values.length !== count)
        throw new AppError("unsupported", "含换行的多个远端 URL 请在终端查看");
      entry[push ? "pushUrls" : "fetchUrls"] = values;
    }
  }
  const head = await headIdentity(repo.rootPath, signal);
  const branch = head.symbolicRef?.slice("refs/heads/".length);
  const remote = branch
    ? (await config(repo, `branch.${branch}.remote`, signal)).at(-1)
    : undefined;
  const defaultFetchRemote =
    remote ??
    (entries.size === 1
      ? entries.keys().next().value
      : entries.has("origin")
        ? "origin"
        : undefined);
  const defaultPushRemote =
    (branch ? (await config(repo, `branch.${branch}.pushRemote`, signal)).at(-1) : undefined) ??
    (await config(repo, "remote.pushDefault", signal)).at(-1) ??
    defaultFetchRemote;
  const upstreamResult = await git(
    repo.rootPath,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    signal,
    { allowedCodes: [0, 1, 128] },
  );
  const upstream = upstreamResult.code === 0 ? commandLine(upstreamResult.bytes) : undefined;
  const pushMode = (await config(repo, "push.default", signal)).at(-1) ?? "simple";
  let description = `按设备 Git 配置${defaultPushRemote ? ` · ${defaultPushRemote}` : ""}`;
  if (branch && defaultPushRemote && !explicitPush.has(defaultPushRemote)) {
    if (pushMode === "current") description = `${defaultPushRemote}/${branch}`;
    else if (
      upstream &&
      defaultPushRemote === remote &&
      (pushMode === "upstream" ||
        (pushMode === "simple" && upstream === (remote === "." ? branch : `${remote}/${branch}`)))
    )
      description = upstream;
  }
  const metadata: GitRemotes = {
    remotes: [...entries.values()],
    upstream,
    defaultFetchRemote,
    defaultPushRemote,
    pushTargetDescription: description,
  };
  if (Buffer.byteLength(JSON.stringify(metadata)) > limits.resultBytes)
    throw new AppError("limit_exceeded", "远端配置超过读取容量，请在终端查看");
  return metadata;
}
export function expectedHead(value: unknown): HeadIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    !("symbolicRef" in value) ||
    !("oid" in value) ||
    (value.symbolicRef !== null && typeof value.symbolicRef !== "string") ||
    (value.oid !== null && typeof value.oid !== "string")
  )
    throw new AppError("invalid_argument", "需要完整 HEAD 身份");
  return { symbolicRef: value.symbolicRef, oid: value.oid };
}
export async function syncRemote(
  repo: Repo,
  kind: "fetch" | "pull" | "push",
  params: { remote?: string; expectedHead?: HeadIdentity },
  signal: AbortSignal,
) {
  if (kind !== "fetch") {
    const current = await headIdentity(repo.rootPath, signal);
    if (
      !params.expectedHead ||
      current.symbolicRef !== params.expectedHead.symbolicRef ||
      current.oid !== params.expectedHead.oid
    )
      throw new AppError("conflict", "当前分支或 HEAD 已变化，请刷新后同步");
  }
  if (
    params.remote &&
    !(await remotes(repo, signal)).remotes.some((entry) => entry.name === params.remote)
  )
    throw new AppError("conflict", "远端已变化，请刷新");
  const result = await git(
    repo.rootPath,
    [
      kind,
      ...(kind === "push" ? ["--porcelain"] : []),
      ...(kind === "fetch" && params.remote ? ["--", params.remote] : []),
    ],
    signal,
    {
      write: true,
      ...(kind === "pull" ? { env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "false" } } : {}),
    },
  );
  return { stdout: result.text, stderr: result.stderr, truncated: result.truncated };
}
