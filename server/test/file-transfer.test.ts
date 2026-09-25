import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { AppError } from "@kiteline/shared/protocol";
import { FileTransfer } from "../src/file-transfer.js";

async function connection() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected socket address");
  const incoming = once(server, "connection");
  const device = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const [relay] = (await incoming) as [WebSocket];
  await once(device, "open");
  return {
    device,
    relay,
    async close() {
      device.terminate();
      relay.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a normal source close drains queued read frames before completing the HTTP body", async () => {
  const sockets = await connection();
  let transfer: FileTransfer | undefined;
  sockets.device.on("message", () => {
    sockets.device.send(Buffer.from("a"));
    sockets.device.send(Buffer.from("b"));
    sockets.device.send(Buffer.from("c"));
    sockets.device.close(1000);
  });
  sockets.relay.on("close", () => {
    void transfer?.sourceClosed().then(() => {
      if (!transfer!.sourceComplete) transfer!.stop(new AppError("offline", "closed"));
    });
  });
  const server = createServer({ highWaterMark: 1 }, (request, response) => {
    transfer = new FileTransfer(
      "file.read",
      { size: 3, filename: "test", contentType: "text/plain" },
      sockets.relay,
      request,
      response,
      5000,
      (error) => transfer!.stop(error),
      () => transfer!.stop(),
      "read-test",
    );
    void transfer.start();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
  } finally {
    transfer?.stop();
    await sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a published write with a lost result reports unknown", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-write-result-");
  const sockets = await connection();
  const chunks: Buffer[] = [];
  let transfer: FileTransfer | undefined;
  sockets.device.on("message", (data, binary) => {
    if (binary) chunks.push(Buffer.from(data as Buffer));
    else if (JSON.parse(data.toString()).type === "end")
      void writeFile(`${root}/file`, Buffer.concat(chunks)).then(() => sockets.device.close(1000));
  });
  sockets.relay.on("close", () => {
    void transfer?.sourceClosed().then(() => {
      if (!transfer!.sourceComplete) transfer!.stop(new AppError("offline", "closed"));
    });
  });
  const server = createServer((request, response) => {
    transfer = new FileTransfer(
      "file.write",
      { size: 4, filename: "file", contentType: "text/plain" },
      sockets.relay,
      request,
      response,
      5000,
      (error) => transfer!.stop(error),
      () => transfer!.stop(),
      "write-test",
    );
    void transfer.start();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: "PUT",
      body: "text",
    });
    expect(await response.json()).toMatchObject({
      id: "write-test",
      outcome: "unknown",
      error: { code: "offline" },
    });
    expect(await readFile(`${root}/file`, "utf8")).toBe("text");
  } finally {
    transfer?.stop();
    await sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
