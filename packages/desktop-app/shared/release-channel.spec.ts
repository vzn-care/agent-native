import { afterEach, describe, expect, it, vi } from "vitest";

import { VZN_CODE_IDENTITY } from "./product-identity";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("desktop protocol identity", () => {
  it.each(["production", "nightly"])(
    "keeps VZN links isolated from the upstream %s channel",
    async (channel) => {
      vi.stubGlobal("__DESKTOP_PRODUCT_IDENTITY__", VZN_CODE_IDENTITY);
      vi.stubGlobal("__AGENT_NATIVE_DESKTOP_RELEASE_CHANNEL__", channel);
      vi.resetModules();
      const identity = await import("./release-channel");
      expect(identity.DESKTOP_DEEP_LINK_PROTOCOL).toBe("vzncode");
      expect(identity.DESKTOP_ACCEPTED_DEEP_LINK_PROTOCOLS).toEqual([
        "vzncode",
      ]);
    },
  );

  it.each([
    ["production", "agentnative"],
    ["nightly", "agentnative-nightly"],
  ])("preserves the upstream %s protocol", async (channel, protocol) => {
    vi.stubGlobal("__AGENT_NATIVE_DESKTOP_RELEASE_CHANNEL__", channel);
    vi.resetModules();
    const identity = await import("./release-channel");
    expect(identity.DESKTOP_DEEP_LINK_PROTOCOL).toBe(protocol);
    expect(identity.DESKTOP_ACCEPTED_DEEP_LINK_PROTOCOLS).toEqual([
      "agentnative",
      "agentnative-nightly",
    ]);
  });
});
