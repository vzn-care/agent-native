import { describe, expect, it } from "vitest";

import { isVznCodeGatewaySignInPopup } from "./vzn-code-gateway-popup";

const base = {
  productAppId: "care.vzn.code",
  sourceAppId: "vzn-code",
  sourceUrl: "http://127.0.0.1:8417/code/home?embedded=1",
  configuredAppUrl: "http://127.0.0.1:8417/code/home",
  popupUrl: "http://127.0.0.1:45840/connect",
};

describe("VZN Code gateway sign-in popup", () => {
  it("allows the local gateway from the configured Code app", () => {
    expect(isVznCodeGatewaySignInPopup(base)).toBe(true);
  });

  it("allows a private HTTPS gateway from the configured preview app", () => {
    expect(
      isVznCodeGatewaySignInPopup({
        ...base,
        sourceUrl: "https://code-preview.example/code/home",
        configuredAppUrl: "https://code-preview.example/code/home",
        popupUrl: "https://studio.example:45841/connect",
      }),
    ).toBe(true);
  });

  it.each([
    { productAppId: undefined },
    { sourceAppId: "mail" },
    { sourceUrl: "http://untrusted.example/code/home" },
    { popupUrl: "http://untrusted.example/connect" },
    { popupUrl: "http://127.0.0.1:45840/other" },
    { popupUrl: "http://127.0.0.1:45840/connect?token=secret" },
    { popupUrl: "http://owner:secret@127.0.0.1:45840/connect" },
  ])("rejects other app and URL shapes: %j", (override) => {
    expect(isVznCodeGatewaySignInPopup({ ...base, ...override })).toBe(false);
  });
});
