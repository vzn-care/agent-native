import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export const BOOTSTRAP_PATH = "/__vzn-preview/bootstrap";
export const RESERVED_COOKIE_PREFIX = "__Host-vzn-preview-";

export interface PreviewRegistration {
  previewId: string;
  projectId: string;
  workspaceId: string;
  ownerDeviceId: string;
  ownershipEpoch: number;
  targetPort: number;
  publicOrigin: string;
  controlOrigin: string;
}

export class PreviewError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Preview operation failed: ${code}`);
    this.name = "PreviewError";
    this.code = code;
  }
}

function origin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PreviewError("INVALID_ORIGIN");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  )
    throw new PreviewError("INVALID_ORIGIN");
  return url;
}

export function validateRegistration(
  input: PreviewRegistration,
): Readonly<PreviewRegistration> {
  for (const field of [
    input.previewId,
    input.projectId,
    input.workspaceId,
    input.ownerDeviceId,
  ]) {
    if (typeof field !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(field))
      throw new PreviewError("INVALID_IDENTITY");
  }
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1)
    throw new PreviewError("INVALID_EPOCH");
  if (
    !Number.isInteger(input.targetPort) ||
    input.targetPort < 1 ||
    input.targetPort > 65535
  )
    throw new PreviewError("INVALID_TARGET");
  const publicUrl = origin(input.publicOrigin);
  const controlUrl = origin(input.controlOrigin);
  if (publicUrl.hostname === controlUrl.hostname)
    throw new PreviewError("SHARED_CONTROL_HOST");
  return Object.freeze({ ...input });
}

export function cookieName(
  registration: Readonly<PreviewRegistration>,
): string {
  return `${RESERVED_COOKIE_PREFIX}${registration.previewId}`;
}

export function sessionCookie(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const values = (headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function requestPath(raw: string | undefined): string {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    /[\\\x00-\x20\x7f]/.test(raw) ||
    /%5c/i.test(raw)
  ) {
    throw new PreviewError("INVALID_PATH");
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(raw, "https://preview.invalid").pathname);
  } catch {
    throw new PreviewError("INVALID_PATH");
  }
  if (path.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(path))
    throw new PreviewError("INVALID_PATH");
  return path;
}

export function validateRequestBoundary(
  headers: IncomingHttpHeaders,
  method: string,
  registration: Readonly<PreviewRegistration>,
  upgrade = false,
  bootstrapPage = false,
): void {
  if (headers.host !== new URL(registration.publicOrigin).host)
    throw new PreviewError("HOST_REJECTED");
  const suppliedOrigin = headers.origin;
  if (
    suppliedOrigin !== undefined &&
    suppliedOrigin !== registration.publicOrigin
  )
    throw new PreviewError("ORIGIN_REJECTED");
  if (
    (upgrade || !["GET", "HEAD"].includes(method)) &&
    suppliedOrigin !== registration.publicOrigin
  ) {
    throw new PreviewError("ORIGIN_REQUIRED");
  }
  if (
    headers["service-worker"] ||
    headers["sec-fetch-dest"] === "serviceworker"
  )
    throw new PreviewError("SERVICE_WORKER_REJECTED");
  if (
    !suppliedOrigin &&
    !bootstrapPage &&
    ["cross-site", "same-site"].includes(String(headers["sec-fetch-site"]))
  ) {
    let trustedFrame = false;
    if (
      headers["sec-fetch-dest"] === "iframe" &&
      typeof headers.referer === "string"
    ) {
      try {
        trustedFrame =
          new URL(headers.referer).origin === registration.controlOrigin;
      } catch {
        trustedFrame = false;
      }
    }
    if (!trustedFrame) throw new PreviewError("CROSS_SITE_REJECTED");
  }
  if (
    upgrade &&
    (method !== "GET" ||
      headers.upgrade?.toLowerCase() !== "websocket" ||
      headers["sec-websocket-version"] !== "13")
  ) {
    throw new PreviewError("UPGRADE_REJECTED");
  }
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function hopNames(headers: IncomingHttpHeaders): Set<string> {
  return new Set([
    ...HOP_HEADERS,
    ...(headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase()),
  ]);
}

function isGatewayHeader(name: string): boolean {
  return (
    ["authorization", "forwarded", "x-real-ip", "www-authenticate"].includes(
      name,
    ) ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("tailscale-")
  );
}

export function forwardRequestHeaders(
  headers: IncomingHttpHeaders,
  registration: Readonly<PreviewRegistration>,
  upgrade = false,
): OutgoingHttpHeaders {
  const blocked = hopNames(headers);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !blocked.has(name) &&
      !isGatewayHeader(name) &&
      !["host", "cookie", "expect"].includes(name)
    )
      result[name] = value;
  }
  const cookies = (blocked.has("cookie") ? "" : (headers.cookie ?? ""))
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, part.indexOf("="));
      return (
        part.includes("=") &&
        !name.toLowerCase().startsWith(RESERVED_COOKIE_PREFIX.toLowerCase())
      );
    });
  if (cookies.length) result.cookie = cookies.join("; ");
  result.host = `127.0.0.1:${registration.targetPort}`;
  result["x-forwarded-host"] = new URL(registration.publicOrigin).host;
  result["x-forwarded-proto"] = "https";
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}

export function redirectLocation(
  location: string,
  registration: Readonly<PreviewRegistration>,
): string {
  let url: URL;
  try {
    if (/[\\\x00-\x20\x7f]/.test(location)) throw new Error();
    url = new URL(location, registration.publicOrigin);
  } catch {
    throw new PreviewError("REDIRECT_REJECTED");
  }
  if (url.username || url.password) throw new PreviewError("REDIRECT_REJECTED");
  const targetOrigin = `http://127.0.0.1:${registration.targetPort}`;
  if (url.origin !== registration.publicOrigin && url.origin !== targetOrigin)
    throw new PreviewError("REDIRECT_REJECTED");
  return `${registration.publicOrigin}${url.pathname}${url.search}${url.hash}`;
}

function appCookie(value: string): string | undefined {
  const parts = value.split(";").map((part) => part.trim());
  const pair = parts.shift();
  if (!pair || !pair.includes("=")) return undefined;
  const name = pair.slice(0, pair.indexOf("="));
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
    name.toLowerCase().startsWith(RESERVED_COOKIE_PREFIX.toLowerCase())
  )
    return undefined;
  const attributes = parts.filter((part) => !/^domain\s*=/i.test(part));
  if (!attributes.some((part) => /^secure$/i.test(part)))
    attributes.push("Secure");
  return [pair, ...attributes].join("; ");
}

export function forwardResponseHeaders(
  headers: IncomingHttpHeaders,
  registration: Readonly<PreviewRegistration>,
  upgrade = false,
): OutgoingHttpHeaders {
  const blocked = hopNames(headers);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !blocked.has(name) &&
      !isGatewayHeader(name) &&
      !name.startsWith("access-control-") &&
      ![
        "set-cookie",
        "location",
        "refresh",
        "clear-site-data",
        "service-worker-allowed",
      ].includes(name)
    )
      result[name] = value;
  }
  if (headers.location && !blocked.has("location"))
    result.location = redirectLocation(headers.location, registration);
  const cookies = (
    blocked.has("set-cookie") ? [] : (headers["set-cookie"] ?? [])
  )
    .map(appCookie)
    .filter((value): value is string => value !== undefined);
  if (cookies.length) result["set-cookie"] = cookies;
  result["referrer-policy"] = "no-referrer";
  result["cache-control"] = "no-store";
  result["content-security-policy"] = [
    ...(typeof headers["content-security-policy"] === "string"
      ? [headers["content-security-policy"]]
      : []),
    `frame-ancestors 'self' ${registration.controlOrigin}`,
  ].join(", ");
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}
