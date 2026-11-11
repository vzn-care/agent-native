# Private application previews

`packages/vzn-code-preview` provides a Node HTTP/1.1 and WebSocket gateway for an application already running on the device that owns a workspace. It binds an ephemeral port on **127.0.0.1 only** and always forwards to a registered numeric port on **127.0.0.1**. A private HTTPS ingress such as Tailscale Serve can expose that gateway to approved devices. This package does not configure Tailscale, start the application, expose a public listener, or complete the Desktop preview UI.

## Trusted registration and lifecycle

Only the owning host may register a preview. The record includes `previewId`, `projectId`, `workspaceId`, `ownerDeviceId`, `ownershipEpoch`, `targetPort`, `publicOrigin`, and `controlOrigin`. The target port must belong to a host-managed application process for that project and ownership epoch. The browser and model must not supply a target URL, host, arbitrary local service port, or public-origin override. In particular, the control API, credential service, and other projects' processes are invalid targets.

The public preview origin must use HTTPS, have no path or credentials, and use a different hostname from the control UI. Use a dedicated hostname for each project's trust boundary; never recycle an origin that has hosted another untrusted application without a fresh browser/storage boundary. Cookies are scoped by hostname rather than port, so using another port on the control hostname does not isolate credentials. Concurrent gateways in one process reject reuse of the same public hostname, even at different ports. The host's durable registry must enforce that isolation across processes and restarts. Control authentication must independently use host-only credentials and strict request-origin checks.

The host journal exposes the ownership check needed by the callback:

```ts
import { startPreview } from "@vzn-care/code-preview";

const preview = await startPreview({
  registration: trustedAppRecord,
  authorize: (record) => {
    const workspace = journal.assertOwner(
      record.workspaceId,
      controller.deviceId,
      record.ownershipEpoch,
    );
    return (
      workspace.projectId === record.projectId &&
      record.ownerDeviceId === controller.deviceId &&
      registeredAppStillOwnsPort(record)
    );
  },
});

// Keep the capability inside authenticated owner IPC/UI; never put it in a URL.
const capability = await preview.issueCapability();
// preview.address is the loopback destination for the private HTTPS ingress.
// preview.bootstrapUrl contains no secret.

// Before transferring ownership, stopping the app, or changing its port:
await preview.revoke();
```

`trustedAppRecord` and `registeredAppStillOwnsPort` are integration responsibilities, not existing registry implementations. The standalone gateway does not infer process ownership from a listening port. The journal check alone is insufficient if an unrelated process can acquire the registered port after the application exits. Serialize app lifecycle, preview registration, and ownership transfer; revoke before releasing the port or epoch. The callback must complete promptly from local authoritative state.

Authority is checked before listening, before issuing a capability, and on every HTTP request or WebSocket upgrade. A one-second authority poll also closes existing streams after ownership loss or an authority-check exception. Explicit revocation is the immediate boundary; polling is a fallback, not a transaction fence. Revocation removes all capabilities and sessions, closes pending upstream requests, destroys upgraded tunnels and HTTP sockets, and stops the listener. It is idempotent. App termination must trigger revocation; an unchanged ownership epoch alone cannot detect that the port has been reused.

## Browser authentication

Capabilities are independently generated random one-time values, separate from the control API bearer. They expire after 60 seconds by default. Only the authenticated owner can request one through the trusted host handle. The unauthenticated bootstrap page is at `/__vzn-preview/bootstrap`; all application traffic requires a preview session.

1. Open `preview.bootstrapUrl` as a top-level window.
2. The bootstrap page sends `vzn-preview-ready` to its opener, addressed only to the configured control origin.
3. The control UI verifies `event.origin === publicOrigin` and `event.source === openedWindow`, then sends `{type: "vzn-preview-capability", capability}` with `postMessage` using the exact preview origin as `targetOrigin`. Never use `*`.
4. The bootstrap page accepts the message only from its actual opener and the configured control origin. It submits the capability in a same-origin JSON POST body. A manual password field offers the same flow if the opener connection is unavailable.
5. The gateway verifies exact Host and Origin, consumes the capability once, and creates a fresh `__Host-vzn-preview-<previewId>` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`. The session lasts 15 minutes by default. The page navigates to `/` without a token in the URL.

Do not log the bootstrap POST body, cookie, or capabilities. No query-token flow exists. GET requests with extra bootstrap query parameters are rejected. Native form fallback also uses POST, so disabled scripting cannot submit the code in a query string. This page cannot be framed. The application can be framed by the configured control origin when both its own policy and browser cookie rules permit it. A cross-site iframe may withhold the Strict cookie even after top-level authentication; use **Open preview** in a top-level window rather than weakening the cookie or placing tokens in URLs. An iframe feature remains a UI integration step.

Session tokens are stored as digests, scoped to this gateway, and expire independently of connection activity. A session's expiry closes its associated streams. A revoked or restarted gateway cannot accept its former cookies. Application response headers cannot set reserved preview cookies or clear site data. Service-worker script requests are rejected so a preview app cannot install a persistent worker over the bootstrap route; use a clean dedicated origin without a previously installed worker.

## Forwarding rules and compatibility

| Boundary                | Behavior                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination             | Fixed `127.0.0.1:<registeredPort>`; no DNS lookup, arbitrary target URL, CONNECT tunnel, or public listener                                                                                                          |
| Incoming Host           | Must exactly equal the configured public HTTPS host, including a nondefault port; duplicate Host/Origin headers are rejected                                                                                         |
| Incoming Origin         | If present, must exactly match the preview origin; required for state-changing requests and every WebSocket upgrade                                                                                                  |
| Browser request context | Cross-site/same-site subresource requests without a matching Origin are rejected, except a recognized iframe navigation from the configured control origin                                                           |
| Request credentials     | Preview cookies, Authorization/Proxy-Authorization, Tailscale identity, supplied forwarding headers, and hop-by-hop headers are removed; ordinary app cookies remain                                                 |
| Upstream identity       | Host is set to the registered loopback address; trusted `X-Forwarded-Host` and `X-Forwarded-Proto: https` describe the public preview                                                                                |
| Response cookies        | Ordinary cookies are retained, forced Secure and host-only; reserved preview-cookie names are discarded                                                                                                              |
| Response security       | Gateway adds no-store, no-referrer, and a framing restriction; preserves the application's CSP as an additional policy; strips CORS expansion, Refresh, Clear-Site-Data, and Service-Worker-Allowed                  |
| Redirects               | Relative/public-origin locations remain on the preview origin; exact registered loopback locations are rewritten; other origins, schemes, credentials, and ambiguous locations are rejected with 502                 |
| WebSocket               | Requires a valid RFC 6455 version-13 handshake, exact Origin, and current session; validates the server accept value/subprotocol, preserves buffered bytes on both ends, then pipes binary traffic with backpressure |

The proxy streams request and response bodies. It does not rewrite HTML, JavaScript, CSS, absolute URLs inside bodies, WebSocket message contents, or application CSP. Configure the dev server to use the public preview URL for HMR and root-relative browser URLs. The incoming public Origin is preserved upstream, so the dev server may need an explicit allowed-origin entry; do not disable the gateway's origin guard to accommodate it.

Applications that require Authorization headers from the browser, external OAuth redirects, service workers, cross-origin API access through the gateway, or response Domain cookies need an explicit future compatibility design. Current behavior rejects or strips those features. The proxy does not make application code safe to run and does not prevent JavaScript from linking to external sites. Its responsibility is preventing preview authority from reaching the app, constraining the target, and separating application code from control authority.

## Private ingress rollout

Before connecting a real remote device:

1. Register a host-supervised app process and verify its actual loopback port, project ID, workspace ID, device owner, and current epoch. Start the gateway and retain its returned loopback address.
2. Route a dedicated private HTTPS preview hostname to that address through the approved private network ingress. Preserve the public Host header and WebSocket upgrades. Keep browser traffic HTTPS end to end to the ingress and keep the gateway listener loopback-only. Do not enable Tailscale Funnel or any public ingress. No ingress command has been executed by this change.
3. Verify TLS and private-device access policy. Request the listener with the wrong Host and verify rejection. Ensure direct remote access to the loopback gateway and app port is impossible.
4. Use the bootstrap flow from an approved remote browser. Verify that its URL/history/referrer contains no capability, the capability is single-use, the session cookie is HttpOnly/Secure/Strict, and a different preview does not accept that session.
5. Load the app, navigate, submit a form, fetch a local API route, and observe a real HMR update over WebSocket. Verify the app receives its own cookies but no preview cookie, control bearer, or Tailscale user identity. Confirm third-party login limitations before relying on that workflow.
6. Revoke while an HTTP stream and WebSocket are open. Confirm both stop immediately, the listener stops, and the old session cannot reconnect. Repeat with an ownership transition and with the application exiting/releasing its port.
7. Test iframe behavior in the actual supported browsers. Retain top-level opening when cookies or the application's CSP prevent embedding. Record the private ingress/version, Node version, browser versions, trusted origin mapping, process registration, and observed results. Do not record secrets.

This rollout remains separate from the local integration checks. Neither successful localhost tests nor a reverse-proxy configuration alone proves remote-device access, Tailscale policy, TLS, browser-cookie behavior, or HMR compatibility with a specific app.

## Verification

From the framework checkout:

```sh
node --test packages/vzn-code-preview/test/policy.test.ts
node --test packages/vzn-code-preview/test/proxy.integration.test.ts
node_modules/.bin/tsc --noEmit -p packages/vzn-code-preview/tsconfig.json \
  --typeRoots node_modules/.pnpm/node_modules/@types
```

The policy suite needs no listening sockets. Integration tests use real loopback HTTP and WebSocket connections, including initial buffered frames and revocation of open streams. They are deliberately not skipped when an execution environment forbids listening sockets: an EPERM failure is an unmet verification prerequisite, not a passing result. These tests do not exercise the host's Unix-domain IPC listener.

References: [Node HTTP upgrade lifecycle](https://nodejs.org/api/http.html#event-upgrade), [cookie scope and security attributes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
