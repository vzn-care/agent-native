export interface DesktopProductIdentity {
  appId: string;
  productName: string;
  protocol: string;
  userDataDirectory: string;
  developmentUserDataDirectory: string;
}

export const VZN_CODE_IDENTITY: DesktopProductIdentity = {
  appId: "care.vzn.code",
  productName: "VZN Code",
  protocol: "vzncode",
  userDataDirectory: "VZN Code",
  developmentUserDataDirectory: "VZN Code Dev",
};

declare const __DESKTOP_PRODUCT_IDENTITY__: DesktopProductIdentity | null;

// An absent identity preserves the upstream profile and release behavior.
export const DESKTOP_PRODUCT_IDENTITY: DesktopProductIdentity | null =
  typeof __DESKTOP_PRODUCT_IDENTITY__ === "undefined"
    ? null
    : __DESKTOP_PRODUCT_IDENTITY__;
