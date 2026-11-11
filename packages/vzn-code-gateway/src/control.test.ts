import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HostClient } from "../../vzn-code-host/src/client.ts";
import { startHost } from "../../vzn-code-host/src/service.ts";
import { startControlGateway } from "./control.ts";

async function enroll(url: string, token: string): Promise<string> {
  const response = await fetch(`${url}/v1/enroll`, {
    method: "POST",
    headers: {
      Origin: url,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.doesNotMatch(cookie, new RegExp(token));
  return cookie.split(";")[0]!;
}

test("gateway rejects unsafe credentials and non-TLS remote origins before opening a listener", async () => {
  const valid = {
    socketPath: "/unused.sock",
    token: randomBytes(32).toString("base64url"),
    allowedOrigins: ["http://localhost:3000"],
  };
  await assert.rejects(
    startControlGateway({ ...valid, token: "short" }),
    /random token/,
  );
  await assert.rejects(
    startControlGateway({
      ...valid,
      allowedOrigins: ["http://studio.example"],
    }),
    /HTTPS/,
  );
  await assert.rejects(
    startControlGateway({
      ...valid,
      publicOrigin: "https://studio.example/path",
    }),
    /without a path/,
  );
});

test("private HTTPS gateway admits exact local and preview origins", async (t) => {
  const localOrigin = "http://127.0.0.1:8417";
  const previewOrigin = "https://code-preview.example";
  const publicOrigin = "https://studio.example";
  const token = randomBytes(32).toString("base64url");
  const gateway = await startControlGateway({
    socketPath: "/unavailable-vzn-host.sock",
    token,
    allowedOrigins: [localOrigin, previewOrigin],
    publicOrigin,
  });
  t.after(() => gateway.close());
  const request = (
    path: string,
    method: string,
    origin: string,
    body?: string,
  ) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
    }>((resolve, reject) => {
      const call = httpRequest(
        `${gateway.url}${path}`,
        {
          method,
          headers: {
            Host: new URL(publicOrigin).host,
            Origin: origin,
            ...(body
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : { "Access-Control-Request-Method": "POST" }),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
            }),
          );
        },
      );
      call.on("error", reject);
      call.end(body);
    });
  const enrollment = await request(
    "/v1/enroll",
    "POST",
    publicOrigin,
    new URLSearchParams({ token }).toString(),
  );
  assert.equal(enrollment.status, 200);
  assert.match(
    String(enrollment.headers["set-cookie"] ?? ""),
    /SameSite=None; Secure/,
  );
  const preflight = (origin: string) => request("/v1/rpc", "OPTIONS", origin);
  for (const origin of [localOrigin, previewOrigin]) {
    const response = await preflight(origin);
    assert.equal(response.status, 204);
    assert.equal(response.headers["access-control-allow-origin"], origin);
    assert.equal(response.headers["access-control-allow-credentials"], "true");
  }
  const rejected = await preflight("https://other-preview.example");
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

test("HTTP admission rejects unauthenticated origins and disabled mutations before touching host IPC", async (t) => {
  const origin = "http://localhost:3000";
  const token = randomBytes(32).toString("base64url");
  const gateway = await startControlGateway({
    socketPath: "/unavailable-vzn-host.sock",
    token,
    allowedOrigins: [origin],
  });
  t.after(() => gateway.close());
  assert.equal((await fetch(`${gateway.url}/connect`)).status, 200);
  assert.equal(
    (
      await fetch(`${gateway.url}/v1/enroll`, {
        method: "POST",
        headers: {
          Origin: "https://untrusted.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token }),
      })
    ).status,
    403,
  );
  const cookie = await enroll(gateway.url, token);
  const opaqueEnrollment = await fetch(`${gateway.url}/v1/enroll`, {
    method: "POST",
    headers: {
      Origin: "null",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });
  assert.equal(opaqueEnrollment.status, 200);
  assert.equal(
    (
      await fetch(`${gateway.url}/v1/enroll`, {
        method: "POST",
        headers: {
          Origin: "null",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: "invalid" }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${gateway.url}/v1/rpc`, {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: "without-cookie",
          kind: "health",
        }),
      })
    ).status,
    401,
  );
  const call = (body: object, overrides: Record<string, string> = {}) =>
    fetch(`${gateway.url}/v1/rpc`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...overrides,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "browser-1",
        ...body,
      }),
    });
  assert.equal(
    (await call({ kind: "health" }, { Cookie: "vzn_code_owner=wrong" })).status,
    401,
  );
  const forbidden = await call(
    { kind: "health" },
    { Origin: "https://untrusted.example" },
  );
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("access-control-allow-origin"), null);
  const mutation = await call({
    kind: "register-project",
    operationId: "enroll",
    projectId: "untrusted",
    root: "/tmp",
    repository: "bad",
  });
  assert.equal(mutation.status, 403);
  assert.equal((await mutation.json()).error.code, "FORBIDDEN");
  const capability = await call({
    kind: "hello",
    capabilities: ["task-control"],
  });
  assert.equal(capability.status, 403);
  assert.equal((await capability.json()).error.code, "FORBIDDEN");
  const unavailable = await call({ kind: "health" });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "HOST_UNAVAILABLE");
  assert.equal(
    (
      await fetch(`${gateway.url}/v1/disconnect`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).status,
    200,
  );
  assert.equal((await call({ kind: "health" })).status, 401);
});

test("browser gateway reads the real IPC catalog and rejects cross-origin, unauthenticated, and root-registration requests", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vzn-gw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = await startHost(dir);
  t.after(() => host.close());
  const local = new HostClient(host.socketPath);
  t.after(() => local.close());
  await local.request({ kind: "hello", capabilities: ["project-catalog"] });
  await local.request({
    kind: "register-project",
    operationId: randomUUID(),
    projectId: "pilot",
    root: dir,
    repository: "gitea:pilot",
  });
  const token = randomBytes(32).toString("base64url");
  const origin = "http://localhost:3000";
  const gateway = await startControlGateway({
    socketPath: host.socketPath,
    token,
    allowedOrigins: [origin],
  });
  t.after(() => gateway.close());
  const cookie = await enroll(gateway.url, token);
  const call = (body: object, overrides: Record<string, string> = {}) =>
    fetch(`${gateway.url}/v1/rpc`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...overrides,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "browser-1",
        ...body,
      }),
    });
  const hello = await call({
    kind: "hello",
    capabilities: ["project-catalog"],
  });
  assert.equal(hello.status, 200);
  assert.equal((await hello.json()).result.protocolVersion, 1);
  const catalog = await call({ kind: "list-projects" });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get("access-control-allow-origin"), origin);
  const body = await catalog.json();
  assert.equal(body.requestId, "browser-1");
  assert.equal(body.result.projects.length, 1);
  assert.equal(body.result.projects[0].id, "pilot");
  assert.equal(
    (
      await call(
        { kind: "list-projects" },
        { Cookie: "vzn_code_owner=invalid" },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await call(
        { kind: "list-projects" },
        { Origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call({
        kind: "register-project",
        operationId: "evil",
        projectId: "untrusted",
        root: dir,
        repository: "bad",
      })
    ).status,
    403,
  );
  const unchanged = (await local.request({ kind: "list-projects" })) as {
    projects: { id: string }[];
  };
  assert.deepEqual(
    unchanged.projects.map((project) => project.id),
    ["pilot"],
  );
});
