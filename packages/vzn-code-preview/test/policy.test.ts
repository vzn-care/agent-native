import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOTSTRAP_PATH,
  cookieName,
  forwardRequestHeaders,
  forwardResponseHeaders,
  redirectLocation,
  requestPath,
  sessionCookie,
  validateRegistration,
  validateRequestBoundary,
} from "../src/policy.ts";
import { startPreview } from "../src/server.ts";

const registration = validateRegistration({
  previewId: "preview-a",
  projectId: "project-a",
  workspaceId: "workspace-a",
  ownerDeviceId: "studio",
  ownershipEpoch: 1,
  targetPort: 3000,
  publicOrigin: "https://preview.example.test",
  controlOrigin: "https://control.example.test",
});
const host = { host: "preview.example.test" };
const token = "x".repeat(43);

test("registration permits only explicit numeric ports and separate canonical HTTPS origins", () => {
  for (const targetPort of [0, -1, 65536, 1.5, Number.NaN, "3000"]) {
    assert.throws(
      () =>
        validateRegistration({
          ...registration,
          targetPort: targetPort as number,
        }),
      { code: "INVALID_TARGET" },
    );
  }
  for (const publicOrigin of [
    "http://preview.example.test",
    "https://user:fake@preview.example.test",
    "https://preview.example.test/path",
    "https://preview.example.test?token=fake",
    "https://preview.example.test/#fragment",
    "https://preview.example.test/../",
  ]) {
    assert.throws(
      () => validateRegistration({ ...registration, publicOrigin }),
      { code: "INVALID_ORIGIN" },
    );
  }
  assert.throws(
    () =>
      validateRegistration({
        ...registration,
        publicOrigin: "https://control.example.test:8443",
      }),
    { code: "SHARED_CONTROL_HOST" },
  );
  assert.throws(
    () => validateRegistration({ ...registration, ownershipEpoch: 0 }),
    { code: "INVALID_EPOCH" },
  );
  assert.equal(Object.isFrozen(registration), true);
});

test("absolute URLs, network paths, escaped separators, and malformed input never become upstream targets", () => {
  for (const raw of [
    undefined,
    "https://evil.test/path",
    "//evil.test/path",
    "/\\evil",
    "/%5cevil",
    "/%2f%2fevil",
    "/%00",
    "/%zz",
  ]) {
    assert.throws(() => requestPath(raw), { code: "INVALID_PATH" });
  }
  assert.equal(requestPath("/api/item?url=https://example.test"), "/api/item");
  assert.equal(requestPath("/x/../__vzn-preview/bootstrap"), BOOTSTRAP_PATH);
});

test("Host and Origin guards reject DNS rebinding and cross-site writes including missing Origin", () => {
  for (const headers of [
    { host: "127.0.0.1" },
    { host: "evil.example.test" },
    { ...host, origin: "https://evil.example.test" },
  ]) {
    assert.throws(() => validateRequestBoundary(headers, "GET", registration));
  }
  assert.throws(() => validateRequestBoundary(host, "POST", registration), {
    code: "ORIGIN_REQUIRED",
  });
  assert.throws(
    () =>
      validateRequestBoundary(
        { ...host, origin: "null" },
        "POST",
        registration,
      ),
    { code: "ORIGIN_REJECTED" },
  );
  validateRequestBoundary(
    { ...host, origin: registration.publicOrigin },
    "POST",
    registration,
  );
  validateRequestBoundary(host, "GET", registration);
});

test("WebSocket upgrades need same-origin browser context and the supported protocol", () => {
  const headers = {
    ...host,
    upgrade: "websocket",
    "sec-websocket-version": "13",
  };
  assert.throws(
    () => validateRequestBoundary(headers, "GET", registration, true),
    { code: "ORIGIN_REQUIRED" },
  );
  assert.throws(
    () =>
      validateRequestBoundary(
        { ...headers, origin: registration.publicOrigin, upgrade: "h2c" },
        "GET",
        registration,
        true,
      ),
    { code: "UPGRADE_REJECTED" },
  );
  validateRequestBoundary(
    { ...headers, origin: registration.publicOrigin },
    "GET",
    registration,
    true,
  );
});

test("cross-site resource requests are blocked while a configured control iframe is recognized", () => {
  assert.throws(
    () =>
      validateRequestBoundary(
        { ...host, "sec-fetch-site": "same-site", "sec-fetch-dest": "script" },
        "GET",
        registration,
      ),
    { code: "CROSS_SITE_REJECTED" },
  );
  assert.throws(
    () =>
      validateRequestBoundary(
        {
          ...host,
          "sec-fetch-site": "same-site",
          "sec-fetch-dest": "iframe",
          referer: "https://evil.example.test/",
        },
        "GET",
        registration,
      ),
    { code: "CROSS_SITE_REJECTED" },
  );
  validateRequestBoundary(
    {
      ...host,
      "sec-fetch-site": "same-site",
      "sec-fetch-dest": "iframe",
      referer: `${registration.controlOrigin}/project`,
    },
    "GET",
    registration,
  );
  assert.throws(
    () =>
      validateRequestBoundary(
        { ...host, "service-worker": "script" },
        "GET",
        registration,
      ),
    { code: "SERVICE_WORKER_REJECTED" },
  );
});

test("ambiguous or foreign preview session cookies cannot authenticate", () => {
  const name = cookieName(registration);
  assert.equal(
    sessionCookie({ cookie: `${name}=${token}; app=value` }, name),
    token,
  );
  assert.equal(
    sessionCookie({ cookie: `${name}=${token}; ${name}=${token}` }, name),
    undefined,
  );
  assert.equal(
    sessionCookie({ cookie: `__Host-vzn-preview-other=${token}` }, name),
    undefined,
  );
  assert.equal(
    sessionCookie({ cookie: `${name}=not-a-token` }, name),
    undefined,
  );
});

test("capability cookies, bearer credentials, proxy identity and Connection-nominated headers never reach the app", () => {
  const forwarded = forwardRequestHeaders(
    {
      ...host,
      authorization: "Bearer FAKE_CONTROL_SECRET",
      "proxy-authorization": "FAKE",
      forwarded: "for=untrusted",
      "x-forwarded-host": "evil.test",
      "tailscale-user-login": "private@example.test",
      cookie: `${cookieName(registration)}=${token}; __Host-vzn-preview-other=${token}; app_session=app-value`,
      connection: "keep-alive, x-internal",
      "x-internal": "private",
      "keep-alive": "timeout=5",
      origin: registration.publicOrigin,
    },
    registration,
  );
  assert.equal(forwarded.cookie, "app_session=app-value");
  assert.equal(forwarded.host, "127.0.0.1:3000");
  assert.equal(forwarded["x-forwarded-host"], "preview.example.test");
  assert.equal(forwarded["x-forwarded-proto"], "https");
  for (const name of [
    "authorization",
    "proxy-authorization",
    "forwarded",
    "tailscale-user-login",
    "connection",
    "x-internal",
    "keep-alive",
  ])
    assert.equal(forwarded[name], undefined);
  assert.equal(JSON.stringify(forwarded).includes(token), false);
});

test("application cookies survive as Secure host-only cookies and cannot replace preview authority", () => {
  const forwarded = forwardResponseHeaders(
    {
      "set-cookie": [
        `${cookieName(registration)}=attacker; Path=/; HttpOnly`,
        "__Host-vzn-preview-other=attacker",
        "app_session=value; Domain=.example.test; Path=/; HttpOnly; SameSite=Lax",
      ],
      "clear-site-data": '"cookies"',
      "access-control-allow-origin": "*",
      "service-worker-allowed": "/",
      "content-security-policy": "default-src 'self'",
    },
    registration,
  );
  assert.deepEqual(forwarded["set-cookie"], [
    "app_session=value; Path=/; HttpOnly; SameSite=Lax; Secure",
  ]);
  assert.equal(forwarded["clear-site-data"], undefined);
  assert.equal(forwarded["access-control-allow-origin"], undefined);
  assert.equal(forwarded["service-worker-allowed"], undefined);
  assert.equal(
    forwarded["content-security-policy"],
    "default-src 'self', frame-ancestors 'self' https://control.example.test",
  );
  assert.equal(forwarded["referrer-policy"], "no-referrer");
});

test("redirects stay on the preview origin; loopback redirects are rewritten and external login redirects fail closed", () => {
  assert.equal(
    redirectLocation("/login?next=%2F", registration),
    `${registration.publicOrigin}/login?next=%2F`,
  );
  assert.equal(
    redirectLocation("http://127.0.0.1:3000/ready#ok", registration),
    `${registration.publicOrigin}/ready#ok`,
  );
  for (const location of [
    "https://evil.example.test",
    "//evil.example.test",
    "javascript:alert(1)",
    "http://localhost:3000",
    "https://fake:secret@preview.example.test/path",
  ]) {
    assert.throws(() => redirectLocation(location, registration), {
      code: "REDIRECT_REJECTED",
    });
  }
});

test("failed ownership is rejected before any listening socket is opened", async () => {
  await assert.rejects(startPreview({ registration, authorize: () => false }), {
    code: "AUTHORITY_REVOKED",
  });
  await assert.rejects(
    startPreview({
      registration,
      authorize: () => {
        throw new Error("FAKE_PRIVATE_JOURNAL_DETAIL");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("FAKE_PRIVATE"), false);
      return true;
    },
  );
});
