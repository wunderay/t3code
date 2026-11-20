/** Why a cloud assignment is not sent, or undefined when it may be. */
export const cloudBlocker = (input: {
  readonly destination: string;
  readonly allowed: boolean;
  readonly bound: boolean;
  readonly routeModel: string | null | undefined;
  readonly model: string | null;
  readonly effort: string | null;
}) => {
  // Nothing leaves the machine for either cloud until the owner allows cloud runs.
  if (!input.allowed) return "Cloud runs are not allowed. Allow them in Settings.";
  if (!input.bound) return "This project has no cloud binding for the route.";
  // Codex cloud picks its own model; a Claude cloud session is proven to run the exact one.
  if (input.destination === "cloud:claude")
    return input.model && input.effort
      ? undefined
      : "Claude cloud needs an exact model and effort.";
  return input.routeModel === "provider-selected" &&
    (!input.model || input.model === "provider-selected")
    ? undefined
    : "Codex cloud runs only with the provider-selected model.";
};
