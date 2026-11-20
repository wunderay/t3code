import { describe, expect, it } from "@effect/vitest";
import { faviconUrlForOrigin, toolActivityFaviconUrl } from "./favicon.ts";
import { DEFAULT_PRIVACY_PREFERENCES, setPrivacyPreferences } from "./privacy.ts";

it("can restore external icons without restoring remote media", () => {
  setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES, externalIcons: true });
  try {
    expect(faviconUrlForOrigin("https://example.com/private?q=x")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    );
  } finally {
    setPrivacyPreferences({ ...DEFAULT_PRIVACY_PREFERENCES });
  }
});

describe("private local favicons", () => {
  it.each([
    "https://github.com/repo",
    "https://customer.example/private?token=x",
    "http://localhost:3000",
    null,
  ])("does not disclose a rendered URL %s", (url) => {
    expect(faviconUrlForOrigin(url)).toBeNull();
  });
  it("does not fetch provider-supplied or themed external icons", () => {
    for (const appearance of ["light", "dark"] as const) {
      expect(
        toolActivityFaviconUrl(
          {
            pageUrl: "https://github.com/repo",
            faviconUrl: "https://example.com/pixel?secret=x",
            faviconUrlDark: "https://example.com/dark",
          },
          appearance,
        ),
      ).toBeNull();
    }
  });
});
