import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => state.userData },
}));
vi.mock("@shared/product-identity", () => ({
  DESKTOP_PRODUCT_IDENTITY: { appId: "care.vzn.code" },
}));

import { loadApps } from "./app-store";

describe("VZN Code Desktop app entry", () => {
  beforeEach(() => {
    state.userData = fs.mkdtempSync(path.join(os.tmpdir(), "vzn-code-app-"));
  });
  afterEach(() => {
    delete process.env.VZN_CODE_APP_URL;
    fs.rmSync(state.userData, { recursive: true, force: true });
  });

  it.each([
    "http://127.0.0.1:8417/code/home",
    "https://code-preview.example/code/home",
  ])("shows a configured Code workflow at %s", (url) => {
    process.env.VZN_CODE_APP_URL = url;
    const entry = loadApps().find((app) => app.id === "vzn-code");
    expect(entry).toMatchObject({ url, enabled: true, workspaceSso: false });
  });

  it("rejects an insecure remote URL", () => {
    process.env.VZN_CODE_APP_URL = "http://code-preview.example/code/home";
    expect(() => loadApps()).toThrow(/HTTPS or local HTTP/);
  });

  it("rejects credentials embedded in the saved URL", () => {
    process.env.VZN_CODE_APP_URL =
      "https://owner:secret@code-preview.example/code/home";
    expect(() => loadApps()).toThrow(/HTTPS or local HTTP/);
  });
});
