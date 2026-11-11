import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type {
  ClientRequest,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import {
  BOOTSTRAP_PATH,
  PreviewError,
  cookieName,
  forwardRequestHeaders,
  forwardResponseHeaders,
  requestPath,
  sessionCookie,
  validateRegistration,
  validateRequestBoundary,
} from "./policy.ts";
import type { PreviewRegistration } from "./policy.ts";

export interface PreviewOptions {
  registration: PreviewRegistration;
  /** Host-owned journal check; never supplied by the browser or preview app. */
  authorize(
    registration: Readonly<PreviewRegistration>,
  ): boolean | Promise<boolean>;
  sessionTtlMs?: number;
  capabilityTtlMs?: number;
}

export interface PreviewHandle {
  readonly registration: Readonly<PreviewRegistration>;
  readonly address: { readonly host: "127.0.0.1"; readonly port: number };
  readonly bootstrapUrl: string;
  /** Return through authenticated host IPC only. Never log or put this in a URL. */
  issueCapability(): Promise<string>;
  /** Invalidates all tokens and destroys HTTP streams, pending requests, and upgraded tunnels. */
  revoke(): Promise<void>;
}

type Session = {
  expiresAt: number;
  sockets: Set<Duplex>;
  timer: ReturnType<typeof setTimeout>;
};
const activeHosts = new Set<string>();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

function boundedDuration(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > maximum)
    throw new PreviewError("INVALID_DURATION");
  return duration;
}

function deny(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(
    status === 401
      ? "Open the preview bootstrap page to authorize this browser."
      : "Preview request rejected.",
  );
}

function denyUpgrade(socket: Duplex, status: number): void {
  if (!socket.destroyed)
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}

function bootstrapPage(controlOrigin: string, nonce: string): string {
  const trustedOrigin = JSON.stringify(controlOrigin).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open private preview</title>
<body><main><h1>Open private preview</h1><form method="post" action="${BOOTSTRAP_PATH}"><label>One-time preview code <input name="code" type="password" autocomplete="off" required></label><button>Open preview</button></form><p role="status"></p></main>
<script nonce="${nonce}">
const controlOrigin=${trustedOrigin};
const form=document.querySelector('form');
const status=document.querySelector('[role=status]');
let pending=false;
async function authorize(capability){
  if(pending||typeof capability!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(capability))return;
  pending=true;status.textContent='Opening preview…';
  try{const response=await fetch('${BOOTSTRAP_PATH}',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({capability})});
    if(!response.ok)throw new Error();location.replace('/');
  }catch{pending=false;status.textContent='This preview code is invalid or expired.';}
  form.reset();
}
form.addEventListener('submit',event=>{event.preventDefault();authorize(new FormData(form).get('code'));});
window.addEventListener('message',event=>{if(event.origin===controlOrigin&&event.source===window.opener&&event.data?.type==='vzn-preview-capability')authorize(event.data.capability);});
if(window.opener)window.opener.postMessage({type:'vzn-preview-ready'},controlOrigin);
</script></body></html>`;
}

async function capabilityBody(request: IncomingMessage): Promise<string> {
  if (request.headers["content-type"] !== "application/json")
    throw new PreviewError("INVALID_BOOTSTRAP_BODY");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024) throw new PreviewError("INVALID_BOOTSTRAP_BODY");
    chunks.push(buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PreviewError("INVALID_BOOTSTRAP_BODY");
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("capability" in body) ||
    typeof body.capability !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.capability)
  )
    throw new PreviewError("INVALID_BOOTSTRAP_BODY");
  return body.capability;
}

function upgradeHeaders(headers: OutgoingHttpHeaders): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      for (const item of Array.isArray(value) ? value : [value])
        lines.push(`${name}: ${item}`);
  }
  return `HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`;
}

function validateRawHeaders(request: IncomingMessage): void {
  const names = request.rawHeaders
    .filter((_value, index) => index % 2 === 0)
    .map((name) => name.toLowerCase());
  if (
    names.filter((name) => name === "host").length !== 1 ||
    names.filter((name) => name === "origin").length > 1
  ) {
    throw new PreviewError("AMBIGUOUS_HEADERS");
  }
}

export async function startPreview(
  options: PreviewOptions,
): Promise<PreviewHandle> {
  const registration = validateRegistration(options.registration);
  const publicHost = new URL(registration.publicOrigin).hostname;
  const sessionTtlMs = boundedDuration(
    options.sessionTtlMs,
    15 * 60_000,
    60 * 60_000,
  );
  const capabilityTtlMs = boundedDuration(
    options.capabilityTtlMs,
    60_000,
    5 * 60_000,
  );
  const capabilities = new Map<string, number>();
  const sessions = new Map<string, Session>();
  const connections = new Set<Duplex>();
  const pendingRequests = new Set<ClientRequest>();
  let revoked = false;
  let closing: Promise<void> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let ownsOrigin = false;
  const server = createServer({ maxHeaderSize: 32 * 1024 });
  server.headersTimeout = 10_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 5000;

  const track = (socket: Duplex) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
  };

  const revoke = (): Promise<void> => {
    if (closing) return closing;
    revoked = true;
    if (poll) clearInterval(poll);
    capabilities.clear();
    for (const session of sessions.values()) clearTimeout(session.timer);
    sessions.clear();
    for (const request of pendingRequests) request.destroy();
    for (const socket of connections) socket.destroy();
    if (ownsOrigin) {
      activeHosts.delete(publicHost);
      ownsOrigin = false;
    }
    closing = new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
    return closing;
  };

  const authorized = async (): Promise<boolean> => {
    if (revoked) return false;
    try {
      const allowed = await options.authorize(registration);
      if (allowed === true && !revoked) return true;
    } catch {
      /* Authority failures revoke existing streams as well as new requests. */
    }
    await revoke();
    return false;
  };

  const authenticate = (request: IncomingMessage): Session | undefined => {
    const token = sessionCookie(request.headers, cookieName(registration));
    const session = token ? sessions.get(digest(token)) : undefined;
    if (!session || session.expiresAt <= Date.now()) return undefined;
    if (!session.sockets.has(request.socket)) {
      session.sockets.add(request.socket);
      request.socket.once("close", () =>
        session.sockets.delete(request.socket),
      );
    }
    return session;
  };

  const issueCapability = async (): Promise<string> => {
    if (!(await authorized())) throw new PreviewError("AUTHORITY_REVOKED");
    for (const [hash, expiry] of capabilities)
      if (expiry <= Date.now()) capabilities.delete(hash);
    if (capabilities.size >= 64) throw new PreviewError("CAPABILITY_LIMIT");
    const capability = secret();
    capabilities.set(digest(capability), Date.now() + capabilityTtlMs);
    return capability;
  };

  const handleBootstrap = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method === "GET") {
      const nonce = randomBytes(18).toString("base64");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(bootstrapPage(registration.controlOrigin, nonce));
      return;
    }
    if (request.method !== "POST") {
      deny(response, 405);
      return;
    }
    let capability: string;
    try {
      capability = await capabilityBody(request);
    } catch {
      deny(response, 400);
      return;
    }
    if (revoked) {
      deny(response, 403);
      return;
    }
    const hash = digest(capability);
    const expiry = capabilities.get(hash);
    capabilities.delete(hash);
    if (expiry === undefined || expiry <= Date.now()) {
      deny(response, 401);
      return;
    }
    if (sessions.size >= 64) {
      deny(response, 429);
      return;
    }
    const token = secret();
    const tokenHash = digest(token);
    const session: Session = {
      expiresAt: Date.now() + sessionTtlMs,
      sockets: new Set(),
      timer: setTimeout(() => {
        sessions.delete(tokenHash);
        for (const socket of session.sockets) socket.destroy();
      }, sessionTtlMs),
    };
    session.timer.unref();
    sessions.set(tokenHash, session);
    response.writeHead(204, {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `${cookieName(registration)}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    });
    response.end();
  };

  const upstreamRequest = (
    request: IncomingMessage,
    upgrade = false,
  ): ClientRequest => {
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: registration.targetPort,
      method: request.method,
      path: request.url,
      headers: forwardRequestHeaders(request.headers, registration, upgrade),
      agent: false,
    });
    pendingRequests.add(upstream);
    upstream.once("close", () => pendingRequests.delete(upstream));
    upstream.on("socket", track);
    return upstream;
  };

  const handleHttp = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    validateRawHeaders(request);
    const path = requestPath(request.url);
    validateRequestBoundary(
      request.headers,
      request.method ?? "",
      registration,
      false,
      path === BOOTSTRAP_PATH && request.method === "GET",
    );
    if (!(await authorized())) {
      deny(response, 403);
      return;
    }
    if (path.startsWith("/__vzn-preview/")) {
      if (request.url !== BOOTSTRAP_PATH) {
        deny(response, 404);
        return;
      }
      await handleBootstrap(request, response);
      return;
    }
    if (!authenticate(request)) {
      deny(response, 401);
      return;
    }
    if (
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        request.method ?? "",
      )
    ) {
      deny(response, 405);
      return;
    }
    const upstream = upstreamRequest(request);
    upstream.on("error", () => deny(response, 502));
    upstream.on("upgrade", (_response, socket) => {
      socket.destroy();
      deny(response, 502);
    });
    upstream.on("response", (upstreamResponse) => {
      upstreamResponse.on("error", () => response.destroy());
      if (revoked || response.destroyed) {
        upstreamResponse.destroy();
        return;
      }
      let headers: OutgoingHttpHeaders;
      try {
        headers = forwardResponseHeaders(
          upstreamResponse.headers,
          registration,
        );
      } catch {
        upstreamResponse.destroy();
        deny(response, 502);
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  };

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    socket.pause();
    validateRawHeaders(request);
    const path = requestPath(request.url);
    validateRequestBoundary(
      request.headers,
      request.method ?? "",
      registration,
      true,
    );
    if (path.startsWith("/__vzn-preview/") || !(await authorized())) {
      denyUpgrade(socket, 403);
      return;
    }
    const session = authenticate(request);
    if (!session) {
      denyUpgrade(socket, 401);
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      denyUpgrade(socket, 400);
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const upstream = upstreamRequest(request, true);
    upstream.on("error", () => denyUpgrade(socket, 502));
    upstream.on("response", (response) => {
      response.destroy();
      denyUpgrade(socket, 502);
    });
    socket.once("close", () => upstream.destroy());
    upstream.on("upgrade", (response, tunnel, upstreamHead) => {
      const protocol = response.headers["sec-websocket-protocol"];
      const requestedProtocols = (
        request.headers["sec-websocket-protocol"] ?? ""
      )
        .split(",")
        .map((value) => value.trim());
      if (
        revoked ||
        session.expiresAt <= Date.now() ||
        socket.destroyed ||
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== "websocket" ||
        response.headers["sec-websocket-accept"] !== accept ||
        (protocol !== undefined && !requestedProtocols.includes(protocol))
      ) {
        tunnel.destroy();
        denyUpgrade(socket, 502);
        return;
      }
      let headers: OutgoingHttpHeaders;
      try {
        headers = forwardResponseHeaders(response.headers, registration, true);
      } catch {
        tunnel.destroy();
        denyUpgrade(socket, 502);
        return;
      }
      session.sockets.add(tunnel);
      tunnel.once("close", () => {
        session.sockets.delete(tunnel);
        socket.destroy();
      });
      socket.once("close", () => tunnel.destroy());
      tunnel.on("error", () => socket.destroy());
      socket.write(upgradeHeaders(headers));
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) tunnel.write(head);
      tunnel.pipe(socket);
      socket.pipe(tunnel);
      socket.resume();
    });
    upstream.end();
  };

  server.on("connection", track);
  server.on("request", (request, response) => {
    handleHttp(request, response).catch(() => deny(response, 403));
  });
  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head).catch(() => denyUpgrade(socket, 403));
  });
  server.on("connect", (_request, socket) => denyUpgrade(socket, 405));
  server.on("clientError", (_error, socket) => denyUpgrade(socket, 400));

  if (!(await authorized())) throw new PreviewError("AUTHORITY_REVOKED");
  if (activeHosts.has(publicHost))
    throw new PreviewError("ORIGIN_ALREADY_ACTIVE");
  activeHosts.add(publicHost);
  ownsOrigin = true;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await revoke();
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    throw new PreviewError(code === "EPERM" ? "LISTEN_EPERM" : "LISTEN_FAILED");
  }
  server.on("error", () => {
    void revoke();
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await revoke();
    throw new PreviewError("LISTEN_FAILED");
  }
  poll = setInterval(() => {
    if (!checking) {
      checking = true;
      authorized()
        .finally(() => {
          checking = false;
        })
        .catch(() => {
          void revoke();
        });
    }
  }, 1000);
  poll.unref();
  return Object.freeze({
    registration,
    address: Object.freeze({ host: "127.0.0.1" as const, port: address.port }),
    bootstrapUrl: `${registration.publicOrigin}${BOOTSTRAP_PATH}`,
    issueCapability,
    revoke,
  });
}
