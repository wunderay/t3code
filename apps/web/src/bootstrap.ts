import { loadPrivacyPreferences } from "./privacyBootstrap";
import { showBootError } from "./lib/bootError";

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void loadPrivacyPreferences()
  .then(() => import("./main"))
  .then(({ startup }) => startup)
  .catch(showBootError);
