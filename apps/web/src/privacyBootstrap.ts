import { DEFAULT_PRIVACY_PREFERENCES, setPrivacyPreferences } from "@t3tools/shared/privacy";

export async function loadPrivacyPreferences(): Promise<void> {
  const preferences = { ...DEFAULT_PRIVACY_PREFERENCES };
  const backend = window.desktopBridge
    ?.getLocalEnvironmentBootstraps()
    .find((entry) => entry.id === "primary")?.httpBaseUrl;
  try {
    const response = await fetch(new URL("/api/privacy", backend ?? window.location.href), {
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const value: unknown = await response.json();
      if (value !== null && typeof value === "object") {
        for (const key of Object.keys(preferences) as Array<keyof typeof preferences>) {
          preferences[key] = (value as Record<string, unknown>)[key] === true;
        }
      }
    }
  } catch {
    // Failed bootstrap keeps optional outbound requests disabled.
  }
  setPrivacyPreferences(preferences);
  if (!preferences.remoteMedia) {
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    const origins = "'self' data: blob: http://127.0.0.1:* http://localhost:* http://[::1]:*";
    const backendOrigin = backend ? new URL(backend).origin : "";
    const images = preferences.externalIcons
      ? "'self' data: blob: http: https:"
      : `${origins} ${backendOrigin}`;
    policy.content = `img-src ${images}; media-src ${origins} ${backendOrigin}`;
    document.head.append(policy);
  }
}
