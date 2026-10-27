import { expect, test } from "vitest";
import { BytePrefix } from "@kiteline/shared/node/buffers";

test("byte prefixes keep the same first bytes across chunk boundaries", () => {
  const input = Buffer.from("abcdefghij");
  for (const chunks of [[input], [input.subarray(0, 3), input.subarray(3)]]) {
    const prefix = new BytePrefix(7);
    for (const chunk of chunks) prefix.append(chunk);
    expect(prefix.bytes).toEqual(Buffer.from("abcdefg"));
    expect(prefix.text()).toBe("abcdefg");
    expect(prefix.truncated).toBe(true);
    prefix.append(Buffer.from("later"));
    expect(prefix.bytes).toEqual(Buffer.from("abcdefg"));
  }
});

test("byte prefixes decode UTF-8 split across chunks and omit a truncated final character", () => {
  const input = Buffer.from("A😀中");
  const complete = new BytePrefix(input.length);
  complete.append(input.subarray(0, 3));
  complete.append(input.subarray(3));
  expect(complete.text()).toBe("A😀中");
  expect(complete.truncated).toBe(false);

  const truncated = new BytePrefix(6);
  truncated.append(input.subarray(0, 3));
  truncated.append(input.subarray(3));
  expect(truncated.bytes).toEqual(input.subarray(0, 6));
  expect(truncated.text()).toBe("A😀");
  expect(truncated.truncated).toBe(true);
});
