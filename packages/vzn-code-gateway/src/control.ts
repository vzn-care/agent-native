import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { HostClient } from "../../vzn-code-host/src/client.ts";
import {
  HostError,
  MAX_FRAME_BYTES,
  parseRequest,
} from "../../vzn-code-host/src/protocol.ts";

export function matchesSecret(
  actual: string | undefined,
  expected: string,
): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HostError(
      "INVALID_REQUEST",
      "Content-Type must be application/json",
    );
  }
  try {
    return JSON.parse((await readBody(request)).toString("utf8"));
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError("INVALID_REQUEST", "Body must be valid JSON");
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_FRAME_BYTES)
      throw new HostError("INVALID_REQUEST", "Request exceeds frame limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

/** Only the local IPC owner starts this bridge. It never opens a public listener. */
export async function startControlGateway(options: {
  socketPath: string;
  token: string;
  allowedOrigins: string[];
  publicOrigin?: string;
  port?: number;
  allowTaskControl?: boolean;
}) {
  if (!/^[a-zA-Z0-9_-]{43,}$/.test(options.token))
    throw new Error(
      "Gateway requires a random token of at least 32 bytes encoded as base64url",
    );
  const origins = new Set(
    options.allowedOrigins.map((origin) => {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw new Error("Browser origins require HTTPS except on loopback");
      return origin;
    }),
  );
  if (origins.size === 0)
    throw new Error("At least one browser origin is required");
  const publicUrl = options.publicOrigin
    ? new URL(options.publicOrigin)
    : undefined;
  if (
    publicUrl &&
    (publicUrl.origin !== options.publicOrigin ||
      publicUrl.protocol !== "https:")
  )
    throw new Error(
      "Public gateway origin must be an HTTPS origin without a path",
    );
  let authority = "";
  const sessions = new Set<string>();
  const cookieName = "vzn_code_owner";
  const cookieAttributes = publicUrl
    ? "Path=/; HttpOnly; SameSite=None; Secure"
    : "Path=/; HttpOnly; SameSite=Strict";
  const gatewayOrigin = publicUrl?.origin;
  const server = createServer(async (request, response) => {
    let requestId = "invalid";
    const origin = request.headers.origin;
    if (request.headers.host !== authority) {
      reply(response, 403, {
        error: { code: "FORBIDDEN", message: "Host or origin is not allowed" },
      });
      return;
    }
    if (request.url === "/connect" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect VZN Code</title><style>body{font:16px system-ui;max-width:28rem;margin:12vh auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box;margin:.8rem 0}input,button{padding:.7rem}</style><h1>Connect VZN Code</h1><p>Enter the Studio owner token here. It stays on this gateway and is not sent to the Code app.</p><form method="post" action="/v1/enroll"><label for="token">Owner token</label><input id="token" name="token" type="password" autocomplete="off" required><button type="submit">Connect</button></form></html>`,
      );
      return;
    }
    if (request.url === "/v1/enroll" && request.method === "POST") {
      const expectedOrigin = gatewayOrigin ?? `http://${authority}`;
      if (
        // Embedded browsers can give a top-level form an opaque origin. The
        // owner token still gates enrollment; RPC keeps exact origin checks.
        (origin !== expectedOrigin && origin !== "null") ||
        request.headers["content-type"]?.split(";")[0] !==
          "application/x-www-form-urlencoded"
      ) {
        reply(response, 403, { error: { code: "FORBIDDEN" } });
        return;
      }
      try {
        const fields = new URLSearchParams(
          (await readBody(request)).toString("utf8"),
        );
        if (!matchesSecret(fields.get("token") ?? undefined, options.token)) {
          reply(response, 401, { error: { code: "UNAUTHORIZED" } });
          return;
        }
        const session = randomBytes(32).toString("base64url");
        sessions.add(session);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'none'",
          "set-cookie": `${cookieName}=${session}; ${cookieAttributes}`,
        });
        response.end(
          '<!doctype html><html lang="en"><meta charset="utf-8"><title>Studio connected</title><h1>Studio connected</h1><p>Return to VZN Code and continue.</p></html>',
        );
      } catch {
        reply(response, 400, { error: { code: "INVALID_REQUEST" } });
      }
      return;
    }
    if (!origin || !origins.has(origin)) {
      reply(response, 403, {
        error: { code: "FORBIDDEN", message: "Host or origin is not allowed" },
      });
      return;
    }
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
    const session = request.headers.cookie?.match(
      /(?:^|;\s*)vzn_code_owner=([A-Za-z0-9_-]{43})(?:;|$)/,
    )?.[1];
    if (request.url === "/v1/disconnect" && request.method === "POST") {
      if (session) sessions.delete(session);
      response.setHeader(
        "set-cookie",
        `${cookieName}=; ${cookieAttributes}; Max-Age=0`,
      );
      reply(response, 200, { disconnected: true });
      return;
    }
    if (request.url !== "/v1/rpc") {
      reply(response, 404, { error: { code: "NOT_FOUND" } });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      reply(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    if (!session || !sessions.has(session)) {
      reply(response, 401, {
        error: {
          code: "UNAUTHORIZED",
          message: "Connect to Studio before using the gateway",
        },
      });
      return;
    }
    try {
      const envelope = parseRequest(await readJson(request));
      requestId = envelope.requestId;
      const taskOperation = [
        "create-workspace",
        "list-workspaces",
        "start-run",
        "cancel-run",
        "run-status",
        "run-transcript",
      ].includes(envelope.kind);
      // Root enrollment and device provisioning remain local-owner operations.
      if (
        !(
          ["hello", "health", "list-projects", "session-events"].includes(
            envelope.kind,
          ) ||
          (taskOperation && options.allowTaskControl)
        )
      ) {
        throw new HostError(
          "FORBIDDEN",
          "This operation is not exposed to browsers",
        );
      }
      if (
        envelope.kind === "hello" &&
        !options.allowTaskControl &&
        envelope.capabilities.includes("task-control")
      )
        throw new HostError(
          "FORBIDDEN",
          "Task control is disabled on this gateway",
        );
      const client = new HostClient(options.socketPath);
      try {
        if (envelope.kind !== "hello")
          await client.request({
            kind: "hello",
            capabilities: [
              "project-catalog",
              "session-event-replay",
              ...(taskOperation ? ["task-control"] : []),
            ],
          });
        const { protocolVersion: _version, requestId: _id, ...body } = envelope;
        let result = await client.request(body);
        if (
          !options.allowTaskControl &&
          (envelope.kind === "hello" || envelope.kind === "health") &&
          result !== null &&
          typeof result === "object"
        ) {
          const hostResult = result as Record<string, unknown>;
          result = {
            ...hostResult,
            executionAvailable: false,
            remoteControlAvailable: false,
            ...(Array.isArray(hostResult.capabilities)
              ? {
                  capabilities: hostResult.capabilities.filter(
                    (capability) => capability !== "task-control",
                  ),
                }
              : {}),
          };
        }
        reply(response, 200, {
          protocolVersion: 1,
          requestId,
          ok: true,
          result,
        });
      } finally {
        client.close();
      }
    } catch (error) {
      const known = error instanceof HostError;
      const code = known ? error.code : "HOST_UNAVAILABLE";
      reply(response, code === "FORBIDDEN" ? 403 : known ? 400 : 503, {
        protocolVersion: 1,
        requestId,
        ok: false,
        error: {
          code,
          message: known ? error.message : "Host connection failed",
        },
      });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Gateway did not acquire a TCP address");
  const url = `http://127.0.0.1:${address.port}`;
  authority = publicUrl?.host ?? new URL(url).host;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        sessions.clear();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
