import { DESKTOP_PRODUCT_IDENTITY } from "./product-identity";

export type DesktopReleaseChannel = "production" | "nightly";

declare const __AGENT_NATIVE_DESKTOP_RELEASE_CHANNEL__:
  | DesktopReleaseChannel
  | undefined;

export const DESKTOP_RELEASE_CHANNEL: DesktopReleaseChannel =
  typeof __AGENT_NATIVE_DESKTOP_RELEASE_CHANNEL__ === "string" &&
  __AGENT_NATIVE_DESKTOP_RELEASE_CHANNEL__ === "nightly"
    ? "nightly"
    : "production";

export const DESKTOP_DEEP_LINK_PROTOCOL =
  DESKTOP_PRODUCT_IDENTITY?.protocol ??
  (DESKTOP_RELEASE_CHANNEL === "nightly"
    ? "agentnative-nightly"
    : "agentnative");

export const DESKTOP_ACCEPTED_DEEP_LINK_PROTOCOLS = DESKTOP_PRODUCT_IDENTITY
  ? [DESKTOP_PRODUCT_IDENTITY.protocol]
  : ["agentnative", "agentnative-nightly"];
