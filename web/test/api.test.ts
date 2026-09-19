import { expect, test, vi } from "vitest";
import { rpcReply } from "../src/lib/api";

test("a lost RPC response is unknown only for writes", async () => {
  const failure = new TypeError("Connection interrupted");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
  try {
    await expect(rpcReply("d", "r", ["files.list", { workspaceId: "w", path: "." }])).rejects.toBe(
      failure,
    );
    await expect(
      rpcReply("d", "r", ["files.delete", { workspaceId: "w", paths: ["file"] }]),
    ).rejects.toMatchObject({ code: "io_error", outcome: "unknown" });
  } finally {
    fetch.mockRestore();
  }
});
