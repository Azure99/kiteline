import { request, type OutgoingHttpHeaders } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { serverConfig } from "../src/config.js";
import { serverFixture, webPath } from "./fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(trusted?: string, hostname = "127.0.0.1") {
  vi.stubEnv("KITELINE_TRUSTED_PROXIES", trusted);
  const f = await serverFixture({ hostname });
  cleanups.push(f.close);
  f.config.trustedProxies = serverConfig().trustedProxies;
  function post({
    headers = {},
    peer = "127.0.0.1",
    path = "/api/login",
    input = { password: "short" },
  }: {
    headers?: OutgoingHttpHeaders;
    peer?: string;
    path?: string;
    input?: Record<string, unknown>;
  } = {}) {
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: peer.includes(":") ? "::1" : "127.0.0.1",
          port: f.port,
          localAddress: peer,
          path: webPath(path),
          method: "POST",
          headers: {
            host: new URL(f.origin).host,
            origin: f.origin,
            "content-type": "application/json",
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (part: string) => (text += part));
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode!, text }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(input));
    });
  }
  return { ...f, post };
}

test.each([undefined, "127.0.0.2"])(
  "untrusted peers ignore forwarding headers (%s)",
  async (trusted) => {
    const f = await fixture(trusted);
    await f.store.setup(f.store.newSetupToken(), "test-password");
    for (let i = 0; i < 10; i++)
      expect(
        (
          await f.post({
            headers: {
              "x-real-ip": `198.51.100.${i + 1}`,
              "x-forwarded-for": `203.0.113.${i + 1}`,
              forwarded: `for=192.0.2.${i + 1}`,
            },
          })
        ).status,
      ).toBe(400);
    expect((await f.post({ input: { password: "test-password" } })).status).toBe(429);
    expect(
      (
        await f.post({
          peer: "127.0.0.3",
          headers: { "x-real-ip": "bad" },
          input: { password: "test-password" },
        })
      ).status,
    ).toBe(200);
  },
);

test("trusted clients have separate source budgets and setup/login retain the global 30", async () => {
  const f = await fixture(" 127.0.0.1, ::1/128 ");
  const headers = { "x-real-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.9" };
  expect(
    (
      await f.post({
        headers,
        path: "/api/setup",
        input: { setupToken: f.store.newSetupToken(), password: "test-password" },
      })
    ).status,
  ).toBe(200);
  for (let i = 0; i < 9; i++) expect((await f.post({ headers })).status).toBe(400);
  expect((await f.post({ headers, input: { password: "test-password" } })).status).toBe(429);
  expect((await f.post({ headers, path: "/api/setup" })).status).toBe(429);
  headers["x-real-ip"] = "198.51.100.2";
  expect((await f.post({ headers, input: { password: "test-password" } })).status).toBe(200);
  for (let i = 0; i < 9; i++) expect((await f.post({ headers })).status).toBe(400);
  headers["x-real-ip"] = "198.51.100.3";
  for (let i = 0; i < 10; i++) expect((await f.post({ headers })).status).toBe(400);
  headers["x-real-ip"] = "198.51.100.4";
  expect((await f.post({ headers, input: { password: "test-password" } })).status).toBe(429);
  expect((await f.post({ headers, path: "/api/setup" })).status).toBe(429);
});

test("trusted peers must supply one valid client IP without falling back to other headers", async () => {
  const f = await fixture("127.0.0.1");
  expect(
    (
      await f.post({
        path: "/api/agent/bind",
        input: { code: f.store.newBinding().code, name: "Proxy-bound device" },
      })
    ).status,
  ).toBe(200);
  for (const value of [
    undefined,
    "",
    "bad",
    "127.0.0.1:80",
    "::1%",
    "::1%a, 192.0.2.1",
    "192.0.2.1, 192.0.2.2",
    ["192.0.2.1", "192.0.2.1"],
  ]) {
    const result = await f.post({
      headers: {
        ...(value === undefined ? {} : { "x-real-ip": value }),
        "x-forwarded-for": "192.0.2.1",
      },
    });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text).error.message).toBe(
      "Expected one valid X-Real-IP from the trusted proxy",
    );
  }
  const headers = { "x-real-ip": "192.0.2.1" };
  for (let i = 0; i < 10; i++) expect((await f.post({ headers })).status).toBe(400);
  expect((await f.post({ headers })).status).toBe(429);
});

test.each([
  { trusted: "::1/128", peer: "::1" },
  { trusted: "127.0.0.0/24", peer: "127.0.0.2" },
])(
  "IPv6 listeners trust $trusted and count equivalent client IPs together",
  async ({ trusted, peer }) => {
    const f = await fixture(trusted, "::");
    for (let i = 0; i < 10; i++)
      expect(
        (
          await f.post({
            peer,
            headers: { "x-real-ip": i % 2 ? "2001:db8::1" : "2001:0db8:0:0:0:0:0:1" },
          })
        ).status,
      ).toBe(400);
    expect((await f.post({ peer, headers: { "x-real-ip": "2001:db8::1" } })).status).toBe(429);
    expect(
      (
        await f.post({
          peer,
          headers: { "x-real-ip": "2001:db8::2" },
          path: "/api/setup",
          input: { setupToken: f.store.newSetupToken(), password: "test-password" },
        })
      ).status,
    ).toBe(200);
  },
);

test("trusted proxy configuration rejects invalid IP and CIDR entries", () => {
  for (const value of [
    "localhost",
    "127.0.0.1,",
    "::1%",
    "::1%a/b",
    "127.0.0.1/33",
    "::1/129",
    "127.0.0.1/",
    "127.0.0.1/0x10",
    "127.0.0.1/24/1",
  ]) {
    vi.stubEnv("KITELINE_TRUSTED_PROXIES", value);
    expect(() => serverConfig()).toThrow("Invalid KITELINE_TRUSTED_PROXIES entry");
  }
});
