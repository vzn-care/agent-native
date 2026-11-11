export function isVznCodeGatewaySignInPopup(input: {
  productAppId: string | undefined;
  sourceAppId: string | undefined;
  sourceUrl: string;
  configuredAppUrl: string | undefined;
  popupUrl: string;
}): boolean {
  if (
    input.productAppId !== "care.vzn.code" ||
    input.sourceAppId !== "vzn-code" ||
    !input.configuredAppUrl
  )
    return false;
  try {
    const source = new URL(input.sourceUrl);
    const configured = new URL(input.configuredAppUrl);
    const popup = new URL(input.popupUrl);
    return (
      source.origin === configured.origin &&
      popup.pathname === "/connect" &&
      !popup.username &&
      !popup.password &&
      !popup.search &&
      !popup.hash &&
      (popup.protocol === "https:" ||
        (popup.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(popup.hostname)))
    );
  } catch {
    return false;
  }
}
