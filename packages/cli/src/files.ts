import { open, stat } from "node:fs/promises";
import {
  AppError,
  limits,
  type FileTarget,
  type Reply,
  type UploadedFile,
} from "@kiteline/shared/protocol";
import { ApiError, apiError, fileDownloadPath } from "@kiteline/shared/protocol/client";
import { client, remote } from "./client.js";
import { target } from "./config.js";
import { result } from "./output.js";
import type { FilePlan } from "./options.js";

async function local<T>(path: string, operation: Promise<T>) {
  try {
    return await operation;
  } catch (error) {
    throw new AppError(
      "io_error",
      `Local file ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function transfer<T>(consume: (signal: AbortSignal, progress: () => void) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("File transfer timed out with no progress")),
    limits.fileIdleTimeout,
  );
  try {
    return await consume(controller.signal, () => timer.refresh());
  } finally {
    clearTimeout(timer);
  }
}

async function download(api: ReturnType<typeof client>, file: FileTarget, output: string) {
  const handle = await local(output, open(output, "wx"));
  try {
    let size = 0;
    await transfer((signal, progress) =>
      api.request(fileDownloadPath(file), { signal }, async (response) => {
        const reader = response.body!.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          progress();
          await local(output, handle.writeFile(value));
          size += value.length;
        }
      }),
    );
    return { path: file.path, output, size };
  } catch (error) {
    const message = `Download to ${JSON.stringify(output)} did not complete: ${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof AppError) throw new AppError(error.code, message, error.details);
    if (error instanceof ApiError)
      throw new ApiError(error.code, message, error.outcome, error.details, error.result);
    throw new ApiError("io_error", message);
  } finally {
    await local(output, handle.close());
  }
}

async function upload(
  api: ReturnType<typeof client>,
  file: FileTarget,
  input: string,
  version: string | undefined,
) {
  const info = await local(input, stat(input));
  if (!info.isFile()) throw new AppError("invalid_argument", "--file must name a regular file");
  const handle = await local(input, open(input, "r"));
  try {
    const ready = await remote(
      api.fileChannel(file, "file.write", {
        purpose: "upload",
        size: info.size,
        createOnly: version === undefined,
        expectedTargetVersion: version,
      }),
    );
    return await remote(
      transfer(async (signal, progress) => {
        const source = handle.createReadStream({ autoClose: false, signal });
        async function* body() {
          for await (const bytes of source) {
            progress();
            yield bytes;
          }
        }
        try {
          // Node fetch accepts an async iterable body with duplex: "half".
          const options = {
            method: "PUT",
            body: body() as unknown as BodyInit,
            duplex: "half",
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(info.size),
            },
            signal,
          };
          return await api.request(
            `/api/channels/${ready.channelId}/content`,
            options,
            async (response) => {
              const reply = (await response.json()) as Reply<UploadedFile>;
              if (reply.outcome !== "succeeded")
                throw apiError(reply.error, reply.outcome, reply.result);
              return reply.result;
            },
          );
        } finally {
          source.destroy();
        }
      }),
    );
  } finally {
    await local(input, handle.close());
  }
}

export async function files(plan: FilePlan, api: ReturnType<typeof client>) {
  const { deviceId, workspaceId } = await target(plan.target);
  const file = { deviceId, workspaceId, path: plan.path };
  if (plan.command === "files download") {
    const value = await download(api, file, plan.output);
    return result(
      value,
      `Downloaded ${value.path} to ${value.output} (${value.size} bytes).`,
      plan.json,
    );
  }
  const value = await upload(api, file, plan.file, plan.replaceVersion);
  return result(value, `Uploaded ${value.path} (${value.size} bytes).`, plan.json);
}
