import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import test from "node:test";
import type { TestContext } from "node:test";

import { startPreview } from "../src/index.ts";
import type { PreviewHandle } from "../src/index.ts";
import { BOOTSTRAP_PATH, cookieName } from "../src/policy.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function fixture(t: TestContext, server: Server, suffix: string) {
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = await listen(server);
  let active = true;
  const registration = {
    previewId: `preview-${suffix}`,
    projectId: "project-a",
    workspaceId: "workspace-a",
    ownerDeviceId: "studio",
    ownershipEpoch: 1,
    targetPort: port,
    publicOrigin: `https://preview-${suffix}.example.test`,
    controlOrigin: "https://control.example.test",
  };
  const handle = await startPreview({ registration, authorize: () => active });
  t.after(() => handle.revoke());
  return {
    handle,
    setInactive: () => {
      active = false;
    },
  };
}

async function call(
  handle: PreviewHandle,
  path: string,
  options: {
    method?: string;
    headers?: IncomingHttpHeaders;
    body?: string;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = request(
      {
        host: handle.address.host,
        port: handle.address.port,
        path,
        method: options.method ?? "GET",
        headers: {
          host: new URL(handle.registration.publicOrigin).host,
          ...options.headers,
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () =>
      req.destroy(new Error("Integration request timed out")),
    );
    req.end(options.body);
  });
}

async function login(handle: PreviewHandle): Promise<string> {
  const capability = await handle.issueCapability();
  const response = await call(handle, BOOTSTRAP_PATH, {
    method: "POST",
    headers: {
      origin: handle.registration.publicOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ capability }),
  });
  assert.equal(response.status, 204);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  assert.match(
    cookie,
    /; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/,
  );
  const pair = cookie.split(";")[0];
  assert.ok(pair);
  return pair;
}

test(
  "real HTTP proxy authenticates once, streams requests, and isolates gateway credentials and app cookies",
  { timeout: 10000 },
  async (t) => {
    let forwarded = 0;
    const app = createServer(async (req, res) => {
      forwarded++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [
          "__Host-vzn-preview-http=attacker; Path=/; HttpOnly",
          "app_session=app-value; Domain=.example.test; Path=/; HttpOnly",
        ],
        connection: "x-internal",
        "x-internal": "private",
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    const { handle } = await fixture(t, app, "http");
    assert.equal(handle.address.host, "127.0.0.1");
    assert.equal((await call(handle, "/app")).status, 401);
    assert.equal(forwarded, 0);
    const capability = await handle.issueCapability();
    const wrongOrigin = await call(handle, BOOTSTRAP_PATH, {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ capability }),
    });
    assert.equal(wrongOrigin.status, 403);
    const bootstrap = await call(handle, BOOTSTRAP_PATH, {
      method: "POST",
      headers: {
        origin: handle.registration.publicOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ capability }),
    });
    assert.equal(bootstrap.status, 204);
    const cookie = bootstrap.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok(cookie);
    const replay = await call(handle, BOOTSTRAP_PATH, {
      method: "POST",
      headers: {
        origin: handle.registration.publicOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ capability }),
    });
    assert.equal(replay.status, 401);
    const response = await call(handle, "/api/items?q=value", {
      method: "POST",
      headers: {
        origin: handle.registration.publicOrigin,
        cookie: `${cookie}; app_session=app-value`,
        authorization: "Bearer FAKE_CONTROL_TOKEN",
        "tailscale-user-login": "private@example.test",
        "content-type": "text/plain",
      },
      body: "request payload",
    });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.method, "POST");
    assert.equal(body.url, "/api/items?q=value");
    assert.equal(body.body, "request payload");
    assert.equal(body.headers.authorization, undefined);
    assert.equal(body.headers["tailscale-user-login"], undefined);
    assert.equal(body.headers.cookie, "app_session=app-value");
    assert.equal(
      body.headers.host,
      `127.0.0.1:${handle.registration.targetPort}`,
    );
    assert.equal(response.headers["x-internal"], undefined);
    assert.deepEqual(response.headers["set-cookie"], [
      "app_session=app-value; Path=/; HttpOnly; Secure",
    ]);
    assert.equal(response.body.includes(capability), false);
    assert.equal(
      response.body.includes(cookie.split("=")[1] ?? "missing-cookie"),
      false,
    );
    assert.equal(
      (
        await call(handle, "/app", {
          headers: { cookie, host: "evil.example.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await call(handle, "/app", { method: "POST", headers: { cookie } }))
        .status,
      403,
    );
    assert.equal(forwarded, 1);
  },
);

test(
  "real preview sessions cannot cross registrations; external redirects and service-worker registration fail closed",
  { timeout: 10000 },
  async (t) => {
    const app = createServer((req, res) => {
      if (req.url === "/external") {
        res.writeHead(302, { location: "https://external.example.test/" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("local app");
      }
    });
    const { handle } = await fixture(t, app, "isolation");
    const cookie = await login(handle);
    const second = await startPreview({
      registration: {
        ...handle.registration,
        previewId: "preview-other",
        publicOrigin: "https://preview-other.example.test",
      },
      authorize: () => true,
    });
    t.after(() => second.revoke());
    assert.equal(
      (await call(second, "/", { headers: { cookie } })).status,
      401,
    );
    assert.equal(
      (await call(handle, "/external", { headers: { cookie } })).status,
      502,
    );
    assert.equal(
      (
        await call(handle, "/sw.js", {
          headers: { cookie, "service-worker": "script" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await call(handle, "/", { headers: { cookie } })).body,
      "local app",
    );
    await assert.rejects(
      startPreview({
        registration: handle.registration,
        authorize: () => true,
      }),
      { code: "ORIGIN_ALREADY_ACTIVE" },
    );
  },
);

function frame(text: string, masked = false): Buffer {
  const bytes = Buffer.from(text);
  assert.ok(bytes.length < 126);
  if (!masked) return Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]);
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from(
    bytes.map((value, index) => value ^ (mask[index % 4] ?? 0)),
  );
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | bytes.length]),
    mask,
    payload,
  ]);
}

function installWebsocketEcho(
  app: Server,
  received: IncomingHttpHeaders[],
): { latest(): Duplex | undefined } {
  let latest: Duplex | undefined;
  app.on("upgrade", (req, socket, head) => {
    latest = socket;
    received.push(req.headers);
    const key = req.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(frame("server-ready"));
    let pending = head;
    const consume = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const length = (pending[1] ?? 0) & 0x7f;
        if (pending.length < length + 6) return;
        const mask = pending.subarray(2, 6);
        const payload = pending
          .subarray(6, length + 6)
          .map((value, index) => value ^ (mask[index % 4] ?? 0));
        socket.write(frame(`echo:${payload.toString()}`));
        pending = pending.subarray(length + 6);
      }
    };
    socket.on("data", consume);
    socket.on("end", () => socket.end());
    socket.on("error", () => socket.destroy());
    consume(Buffer.alloc(0));
  });
  return { latest: () => latest };
}

function websocket(handle: PreviewHandle, cookie: string) {
  const socket = connect(handle.address.port, handle.address.host);
  let resolveUpgrade: ((value: number) => void) | undefined;
  let rejectUpgrade: ((error: Error) => void) | undefined;
  let resolveMessages: ((value: string[]) => void) | undefined;
  const upgraded = new Promise<number>((resolve, reject) => {
    resolveUpgrade = resolve;
    rejectUpgrade = reject;
  });
  const messages = new Promise<string[]>((resolve) => {
    resolveMessages = resolve;
  });
  let pending = Buffer.alloc(0);
  let handshake = false;
  const received: string[] = [];
  socket.on("error", (error) => rejectUpgrade?.(error));
  socket.on("data", (chunk) => {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    if (!handshake) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = Number(pending.toString("ascii", 0, end).split(" ")[1]);
      resolveUpgrade?.(status);
      handshake = true;
      pending = pending.subarray(end + 4);
    }
    while (pending.length >= 2) {
      const length = (pending[1] ?? 0) & 0x7f;
      if (pending.length < length + 2) return;
      received.push(pending.toString("utf8", 2, length + 2));
      pending = pending.subarray(length + 2);
      if (received.length === 2) resolveMessages?.(received);
    }
  });
  socket.once("connect", () => {
    const headers = `GET /hmr HTTP/1.1\r\nHost: ${new URL(handle.registration.publicOrigin).host}\r\nOrigin: ${handle.registration.publicOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nCookie: ${cookie}; app_session=app-value\r\nAuthorization: Bearer FAKE_CONTROL_TOKEN\r\n\r\n`;
    socket.write(
      Buffer.concat([Buffer.from(headers), frame("client-ready", true)]),
    );
  });
  return { socket, upgraded, messages };
}

test(
  "real WebSocket forwarding preserves both handshake buffers and closes both tunnel ends on revocation",
  { timeout: 10000 },
  async (t) => {
    const app = createServer((_req, res) => {
      res.end("app");
    });
    const received: IncomingHttpHeaders[] = [];
    const echo = installWebsocketEcho(app, received);
    const { handle } = await fixture(t, app, "ws");
    const unauthenticated = websocket(handle, "app_session=only");
    t.after(() => unauthenticated.socket.destroy());
    assert.equal(await unauthenticated.upgraded, 401);
    assert.equal(received.length, 0);
    const cookie = await login(handle);
    const client = websocket(handle, cookie);
    t.after(() => client.socket.destroy());
    assert.equal(await client.upgraded, 101);
    assert.deepEqual(await client.messages, [
      "server-ready",
      "echo:client-ready",
    ]);
    assert.equal(received[0]?.authorization, undefined);
    assert.equal(received[0]?.cookie, "app_session=app-value");
    assert.equal(received[0]?.origin, handle.registration.publicOrigin);
    const upstream = echo.latest();
    assert.ok(upstream);
    const downstreamClosed = once(client.socket, "close");
    const upstreamClosed = once(upstream, "close");
    await handle.revoke();
    await Promise.all([downstreamClosed, upstreamClosed]);
    await handle.revoke();
    await assert.rejects(handle.issueCapability(), {
      code: "AUTHORITY_REVOKED",
    });
  },
);

test(
  "owner epoch invalidation closes an existing HTTP stream and disables new capabilities",
  { timeout: 10000 },
  async (t) => {
    const app = createServer((_req, res) => {
      res.writeHead(200);
      res.write("stream-started\n");
    });
    const { handle, setInactive } = await fixture(t, app, "epoch");
    const cookie = await login(handle);
    const req = request({
      host: handle.address.host,
      port: handle.address.port,
      path: "/stream",
      headers: {
        host: new URL(handle.registration.publicOrigin).host,
        cookie,
      },
      agent: false,
    });
    req.on("error", () => req.destroy());
    t.after(() => req.destroy());
    const responsePromise = once(req, "response");
    req.end();
    const [response] = await responsePromise;
    response.on("error", () => response.destroy());
    const streamClosed = once(response, "close").catch(() => undefined);
    response.resume();
    setInactive();
    await streamClosed;
    await assert.rejects(handle.issueCapability(), {
      code: "AUTHORITY_REVOKED",
    });
    assert.equal(
      cookie.startsWith(`${cookieName(handle.registration)}=`),
      true,
    );
  },
);
