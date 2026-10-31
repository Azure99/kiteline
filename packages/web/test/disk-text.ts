import type { DiskText } from "../src/files/content";

export function diskText({
  path,
  text,
  revision,
}: {
  path: string;
  text: string;
  revision: string;
}): DiskText {
  return {
    target: { deviceId: "device", workspaceId: "workspace", path },
    text,
    raw: text,
    meta: {
      size: Buffer.byteLength(text),
      contentType: "text/plain",
      filename: path,
      revision,
      bom: false,
      lineEnding: "lf",
    },
  };
}
