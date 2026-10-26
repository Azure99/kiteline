import { randomUUID } from "node:crypto";
import { limits } from "@kiteline/shared/protocol";
import { ApiError, createApiClient } from "@kiteline/shared/protocol/client";
import { withServerResponse } from "@kiteline/shared/node/network";
import type { Credentials } from "./config.js";

export function client(credentials: Credentials) {
  return createApiClient({
    newId: randomUUID,
    request: async (path, options, consume) => {
      try {
        return await withServerResponse(
          new URL(path, credentials.server),
          {
            ...options,
            redirect: "error",
            headers: {
              ...options.headers,
              origin: credentials.server,
              authorization: `Bearer ${credentials.token}`,
            },
            signal: options.signal ?? AbortSignal.timeout(limits.interactionTimeout),
          },
          consume,
        );
      } catch (error) {
        if (error instanceof Error) {
          let cause = error;
          while (cause.cause instanceof Error) cause = cause.cause;
          const detail = cause.message || (cause as NodeJS.ErrnoException).code;
          // Keep the error type for createApiClient's outcome handling.
          if (detail && detail !== error.message) error.message += `: ${detail}`;
        }
        throw error;
      }
    },
  });
}

export async function remote<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("io_error", error instanceof Error ? error.message : String(error));
  }
}
