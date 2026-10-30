import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, limits, record, string } from "@kiteline/shared/protocol";
import type { ServerConfig } from "./config.js";
import type { Connections } from "./connections.js";
import { Store, password, type Login } from "./store.js";
import {
  AttemptLimiter,
  body,
  clientAddress,
  decodePath,
  json,
  loginCookie,
  requireDevice,
  requireLogin,
  requireOrigin,
  requireOwner,
  requireVersion,
} from "./http.js";
import { installationCommands, upgradeCommand } from "./agent-installation.js";
import { serverLimits } from "./limits.js";

type LoginContext = { login: Login };
type DeviceContext = LoginContext & { deviceId: string };
type BodyHandler<Context> =
  | {
      body: "none";
      handle: (context: Context) => void | Promise<void>;
    }
  | {
      body: "json";
      handle: (context: Context & { input: Record<string, unknown> }) => void | Promise<void>;
    };
type AuthenticatedRoute = {
  identity: "login" | "owner";
  version: "required" | "recovery";
} & (
  | ({ rawDeviceId?: undefined } & BodyHandler<LoginContext>)
  | ({ rawDeviceId: string } & BodyHandler<DeviceContext>)
);
type ApiRoute =
  | { identity: "public"; rawDeviceId?: undefined; handle: () => void }
  | {
      identity: "password";
      rawDeviceId?: undefined;
      handle: (input: Record<string, unknown>) => void | Promise<void>;
    }
  | AuthenticatedRoute;

export function createApiHandler(config: ServerConfig, store: Store, connections: Connections) {
  const channels = connections.channels;
  const authenticationLimiter = new AttemptLimiter();

  function matchApi(
    method: string,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
    entryOrigin: string,
  ): ApiRoute {
    const path = url.pathname;
    if (path === "/api/bootstrap" && method === "GET")
      return {
        identity: "public",
        handle: () => json(response, 200, { initialized: store.initialized() }),
      };
    if ((path === "/api/setup" || path === "/api/login") && method === "POST")
      return {
        identity: "password",
        handle: async (input) => {
          const value = password(input.password);
          if (path === "/api/setup")
            await store.setup(string(input.setupToken, "setup token", 256), value);
          else if (!(await store.verifyPassword(value)))
            throw new AppError("unauthenticated", "Incorrect password");
          const login = store.createLogin(serverLimits.loginLifetime);
          response.setHeader("set-cookie", loginCookie(entryOrigin, login.token, login.expiresAt));
          json(response, 200, { expiresAt: login.expiresAt });
        },
      };
    if (path === "/api/session" && method === "GET")
      return {
        identity: "login",
        version: "recovery",
        body: "none",
        handle: ({ login }) =>
          json(response, 200, {
            expiresAt: login.expiresAt,
            ...(login.kind === "owner"
              ? {}
              : {
                  kind: "cli",
                  id: login.id,
                  name: login.name,
                  deviceIds: login.deviceIds,
                }),
          }),
      };
    if (path === "/api/logout" && method === "POST")
      return {
        identity: "login",
        version: "recovery",
        body: "none",
        handle: ({ login }) => {
          connections.logout(login.id);
          if (login.kind === "owner")
            response.setHeader("set-cookie", loginCookie(entryOrigin, "", ""));
          json(response, 200, {});
        },
      };
    if (path === "/api/devices" && method === "GET")
      return {
        identity: "login",
        version: "recovery",
        body: "none",
        handle: ({ login }) => json(response, 200, { devices: connections.devices(login) }),
      };
    if (path === "/api/agent/upgrade-command" && method === "GET")
      return {
        identity: "owner",
        version: "recovery",
        body: "none",
        handle: () => json(response, 200, upgradeCommand(entryOrigin)),
      };
    if (path === "/api/credentials") {
      if (method === "GET")
        return {
          identity: "owner",
          version: "required",
          body: "none",
          handle: () => json(response, 200, { credentials: store.credentials() }),
        };
      if (method === "POST")
        return {
          identity: "owner",
          version: "required",
          body: "json",
          handle: ({ input }) => {
            const name = string(input.name, "credential name", limits.nameLength);
            if (!Array.isArray(input.deviceIds) || !input.deviceIds.length)
              throw new AppError("invalid_argument", "Select at least one device");
            const deviceIds = [
              ...new Set(input.deviceIds.map((id) => string(id, "device ID", 128))),
            ];
            const expiresAt = input.expiresAt;
            if (
              expiresAt !== null &&
              (typeof expiresAt !== "string" ||
                !Number.isFinite(Date.parse(expiresAt)) ||
                Date.parse(expiresAt) <= Date.now() ||
                Date.parse(expiresAt) >= Date.UTC(10000, 0, 1))
            )
              throw new AppError(
                "invalid_argument",
                "Choose a future expiry before year 10000, or explicit null for no expiry",
              );
            json(
              response,
              200,
              store.createCredential(
                name,
                deviceIds,
                expiresAt === null ? null : new Date(expiresAt).toISOString(),
              ),
            );
          },
        };
    }
    const credential = /^\/api\/credentials\/([^/]+)$/.exec(path);
    if (credential && method === "DELETE")
      return {
        identity: "owner",
        version: "required",
        body: "none",
        handle: () => {
          const id = decodePath(credential[1]!);
          const revoked = connections.revokeCredential(id);
          json(response, 200, { revoked });
        },
      };
    if (path === "/api/tasks" && method === "GET")
      return {
        identity: "login",
        version: "required",
        body: "none",
        handle: ({ login }) => {
          const deviceId = url.searchParams.get("deviceId") ?? undefined;
          if (deviceId) requireDevice(login, deviceId);
          json(response, 200, { devices: connections.taskSummaries(login, deviceId) });
        },
      };
    if (path === "/api/bindings" && method === "POST")
      return {
        identity: "owner",
        version: "required",
        body: "none",
        handle: () => {
          const binding = store.newBinding();
          json(response, 200, {
            ...binding,
            commands: installationCommands(entryOrigin, binding.code),
          });
        },
      };
    const binding = /^\/api\/bindings\/([^/]+)$/.exec(path);
    if (binding && method === "GET")
      return {
        identity: "owner",
        version: "required",
        body: "none",
        handle: () => json(response, 200, store.binding(decodePath(binding[1]!))),
      };
    const content = /^\/api\/channels\/([^/]+)\/content$/.exec(path);
    if (content && (method === "GET" || method === "PUT"))
      return {
        identity: "login",
        version: "required",
        body: "none",
        handle: ({ login }) =>
          channels.content(decodePath(content[1]!), login.id, request, response),
      };
    const channel = /^\/api\/channels\/([^/]+)$/.exec(path);
    if (channel && method === "DELETE")
      return {
        identity: "login",
        version: "required",
        body: "none",
        handle: ({ login }) =>
          json(response, 200, {
            found: channels.cancel(
              decodePath(channel[1]!),
              new AppError("cancelled", "Channel cancelled"),
              login.id,
            ),
          }),
      };
    const device = /^\/api\/devices\/([^/]+)(.*)$/.exec(path);
    if (device) {
      const rawDeviceId = device[1]!;
      const suffix = device[2];
      if (suffix === "/download" && method === "GET")
        return {
          identity: "login",
          version: "required",
          rawDeviceId,
          body: "none",
          handle: async ({ login, deviceId }) => {
            await channels.createDownload(
              deviceId,
              login,
              {
                workspaceId: string(url.searchParams.get("workspaceId")),
                path: string(url.searchParams.get("path")),
              },
              { request, response },
            );
          },
        };
      if (suffix === "/channels" && method === "POST")
        return {
          identity: "login",
          version: "required",
          rawDeviceId,
          body: "json",
          handle: async ({ login, input, deviceId }) => {
            const pending = channels.create(
              deviceId,
              login,
              string(input.kind),
              record(input.params),
            );
            response.on("close", () => {
              if (!response.writableFinished)
                channels.cancel(pending.id, new AppError("cancelled", "Request closed"));
            });
            json(response, 200, await pending.ready);
          },
        };
      if (!suffix && method === "PATCH")
        return {
          identity: "owner",
          version: "required",
          rawDeviceId,
          body: "json",
          handle: ({ input, deviceId }) => {
            connections.renameDevice(
              deviceId,
              string(input.name, "device name", limits.nameLength),
            );
            json(response, 200, {});
          },
        };
      if (!suffix && method === "DELETE")
        return {
          identity: "owner",
          version: "required",
          rawDeviceId,
          body: "none",
          handle: ({ deviceId }) => {
            connections.deleteDevice(deviceId);
            json(response, 200, {});
          },
        };
      if (suffix === "/notices/activate" && method === "POST")
        return {
          identity: "login",
          version: "required",
          rawDeviceId,
          body: "json",
          handle: ({ input, deviceId }) => {
            connections.activateReport(
              deviceId,
              string(input.workspaceId),
              string(input.sessionId),
            );
            json(response, 200, {});
          },
        };
      if (suffix === "/rpc" && method === "POST")
        return {
          identity: "login",
          version: "required",
          rawDeviceId,
          body: "json",
          handle: async ({ login, input, deviceId }) => {
            const requestId = string(input.id, "request id", 128);
            const pending = connections.rpc(
              deviceId,
              login,
              requestId,
              string(input.method, "method", 128),
              record(input.params),
            );
            response.on("close", () => {
              if (!response.writableFinished) connections.cancel(deviceId, requestId, login.id);
            });
            json(response, 200, await pending);
          },
        };
      const cancel = /^\/requests\/([^/]+)$/.exec(suffix ?? "");
      if (cancel && method === "DELETE")
        return {
          identity: "login",
          version: "required",
          rawDeviceId,
          body: "none",
          handle: ({ login, deviceId }) =>
            json(response, 200, {
              found: connections.cancel(deviceId, decodePath(cancel[1]!), login.id),
            }),
        };
    }
    return {
      identity: "login",
      version: "required",
      body: "none",
      handle: () => {
        throw new AppError("not_found", "API endpoint not found");
      },
    };
  }

  return async function serveApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    entryOrigin: string,
  ) {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") requireOrigin(request, entryOrigin);
    const route = matchApi(method, url, request, response, entryOrigin);
    if (route.identity === "public") return route.handle();
    if (route.identity === "password") {
      authenticationLimiter.check(clientAddress(request, config.trustedProxies));
      return route.handle(record(await body(request)));
    }
    const login = requireLogin(store, request, entryOrigin);
    if (route.version === "required")
      requireVersion(url.searchParams.get("appVersion"), login.kind === "owner" ? "web" : "cli");
    let deviceId: string | undefined;
    if (route.rawDeviceId !== undefined) {
      deviceId = decodePath(route.rawDeviceId);
      requireDevice(login, deviceId);
    }
    if (route.identity === "owner") requireOwner(login);
    const context = { login, deviceId: deviceId! };
    if (route.body === "json") {
      const input = record(await body(request));
      // Reading the body can outlive the login that admitted the request.
      if (requireLogin(store, request, entryOrigin).id !== login.id)
        throw new AppError("unauthenticated", "Login session ended");
      return route.handle({ ...context, input });
    }
    return route.handle(context);
  };
}
