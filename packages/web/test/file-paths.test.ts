import { expect, test } from "vitest";
import { deviceAbsolutePath } from "../src/files/paths";

test.each([
  ["/workspace/project", "files/说明's file.txt", "/workspace/project/files/说明's file.txt"],
  ["/", "files/name.txt", "/files/name.txt"],
  ["C:\\project", "files/说明's file.txt", "C:\\project\\files\\说明's file.txt"],
  ["C:\\", "name.txt", "C:\\name.txt"],
  ["\\\\server\\share", "files/name.txt", "\\\\server\\share\\files\\name.txt"],
  ["\\\\server\\share\\project\\", "files/name.txt", "\\\\server\\share\\project\\files\\name.txt"],
] as const)(
  "device path from %s preserves the final relative file path",
  (root, relative, expected) => {
    expect(deviceAbsolutePath(root, relative)).toBe(expected);
  },
);
