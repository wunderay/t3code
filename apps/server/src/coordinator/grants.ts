import type { CoordinatorGrant, RuntimeMode } from "@t3tools/contracts";

/**
 * A delegated thread's mode comes from its grant, never from the thread that launched it. Edits
 * inside its worktree go ahead; everything else reaches the host, which answers by rule. Full
 * access is never given: requests would no longer reach the host, so the danger list could not ask.
 */
export const runtimeModeForGrant = (grant: CoordinatorGrant | null): RuntimeMode =>
  grant && !grant.revoked && (grant.maxAccess ?? 1) >= 1
    ? "auto-accept-edits"
    : "approval-required";
