import { timingSafeEqual } from "node:crypto";
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
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_FRAME_BYTES)
      throw new HostError("INVALID_REQUEST", "Request exceeds frame limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HostError("INVALID_REQUEST", "Body must be valid JSON");
  }
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
  const server = createServer(async (request, response) => {
    let requestId = "invalid";
    const origin = request.headers.origin;
    if (request.headers.host !== authority || !origin || !origins.has(origin)) {
      reply(response, 403, {
        error: { code: "FORBIDDEN", message: "Host or origin is not allowed" },
      });
      return;
    }
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    if (request.url !== "/v1/rpc") {
      reply(response, 404, { error: { code: "NOT_FOUND" } });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      reply(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    if (
      !matchesSecret(request.headers.authorization, `Bearer ${options.token}`)
    ) {
      reply(response, 401, {
        error: {
          code: "UNAUTHORIZED",
          message: "A valid owner token is required",
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
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
