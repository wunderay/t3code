import { afterEach, expect, it } from "@effect/vitest";
import {
  DEFAULT_PRIVACY_PREFERENCES,
  allowsDirectMedia,
  getPrivacyPreferences,
  setPrivacyPreferences,
} from "./privacy.ts";

afterEach(() => setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES }));

it("privacy defaults disable optional requests while retaining local coding media", () => {
  setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES });
  expect(Object.values(getPrivacyPreferences()).every((value) => value === false)).toBe(true);
  for (const url of [
    "data:image/png;base64,AA",
    "blob:https://app.example/id",
    "http://127.0.0.1:3773/asset",
    "http://localhost:5000/screenshot",
  ])
    expect(allowsDirectMedia(url)).toBe(true);
  expect(allowsDirectMedia("https://external.example/pixel?data=private")).toBe(false);
  expect(allowsDirectMedia("https://localhost.external.example/pixel")).toBe(false);
});

it("media and external icons can be re-enabled independently", () => {
  setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES, externalIcons: true });
  expect(allowsDirectMedia("https://external.example/pixel")).toBe(false);
  setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES, remoteMedia: true });
  expect(getPrivacyPreferences().externalIcons).toBe(false);
  expect(allowsDirectMedia("https://external.example/image")).toBe(true);
  expect(allowsDirectMedia("javascript:alert(1)")).toBe(false);
});

it("allows an explicit T3 backend origin without trusting sibling hosts", () => {
  setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES });
  expect(allowsDirectMedia("http://172.20.1.2:3773/asset", ["http://172.20.1.2:3773"])).toBe(true);
  expect(allowsDirectMedia("http://172.20.1.3:3773/asset", ["http://172.20.1.2:3773"])).toBe(false);
});
