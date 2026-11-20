import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_PRIVACY_PREFERENCES,
  getPrivacyPreferences,
  setPrivacyPreferences,
} from "@t3tools/shared/privacy";
import { loadPrivacyPreferences } from "./privacyBootstrap";

afterEach(() => {
  vi.unstubAllGlobals();
  setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES });
});

function fixture(value: unknown) {
  const append = vi.fn();
  const fetch = vi.fn().mockResolvedValue(Response.json(value));
  vi.stubGlobal("window", {
    location: new URL("http://app.example/"),
    desktopBridge: {
      getLocalEnvironmentBootstraps: () => [
        { id: "primary", httpBaseUrl: "http://127.0.0.1:3773" },
      ],
    },
  });
  vi.stubGlobal("document", {
    head: { append },
    createElement: () => ({ httpEquiv: "", content: "" }),
  });
  vi.stubGlobal("fetch", fetch);
  return { append, fetch };
}

it("loads only known Boolean preferences before optional services and uses no credential", async () => {
  const { append, fetch } = fixture({
    diagnosticExports: true,
    codexReporting: true,
    unexpected: "private",
    connect: "true",
  });
  await loadPrivacyPreferences();
  expect(getPrivacyPreferences()).toEqual({
    ...DEFAULT_PRIVACY_PREFERENCES,
    diagnosticExports: true,
    codexReporting: true,
  });
  expect(fetch.mock.calls[0]?.[0].href).toBe("http://127.0.0.1:3773/api/privacy");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", cache: "no-store" });
  expect(append).toHaveBeenCalledOnce();
  expect(append.mock.calls[0]?.[0].content).toContain("img-src 'self' data: blob:");
});

it("allows icons independently while keeping media confinement", async () => {
  const { append } = fixture({ externalIcons: true, remoteMedia: false });
  await loadPrivacyPreferences();
  const policy = append.mock.calls[0]?.[0].content as string;
  expect(policy.split(";")[0]).toContain("http: https:");
  expect(policy.split(";")[1]).not.toContain("http: https:");
  expect(getPrivacyPreferences().remoteMedia).toBe(false);
});

it("allows remote media without turning on optional icons", async () => {
  const { append } = fixture({ remoteMedia: true });
  await loadPrivacyPreferences();
  expect(append).not.toHaveBeenCalled();
  expect(getPrivacyPreferences().externalIcons).toBe(false);
});

it("keeps optional requests off if preference loading fails", async () => {
  const { fetch, append } = fixture({});
  fetch.mockRejectedValue(new Error("offline"));
  await loadPrivacyPreferences();
  expect(getPrivacyPreferences()).toEqual(DEFAULT_PRIVACY_PREFERENCES);
  expect(append).toHaveBeenCalledOnce();
});
