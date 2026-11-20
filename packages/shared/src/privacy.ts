import type { PrivacyPreferences } from "@t3tools/contracts";

export const DEFAULT_PRIVACY_PREFERENCES: PrivacyPreferences = {
  productAnalytics: false,
  diagnosticExports: false,
  connect: false,
  activityPublishing: false,
  externalIcons: false,
  remoteMedia: false,
  codexReporting: false,
  claudeReporting: false,
};

declare global {
  var __t3PrivacyPreferences: PrivacyPreferences | undefined;
}

export const getPrivacyPreferences = (): PrivacyPreferences =>
  globalThis.__t3PrivacyPreferences ?? DEFAULT_PRIVACY_PREFERENCES;

export const setPrivacyPreferences = (preferences: PrivacyPreferences): void => {
  globalThis.__t3PrivacyPreferences = preferences;
};

export function allowsDirectMedia(
  rawUrl: string,
  localOrigins: ReadonlyArray<string> = [],
): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      getPrivacyPreferences().remoteMedia ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      localOrigins.includes(url.origin)
    );
  } catch {
    return false;
  }
}
