import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  balancesNewThreadAccount,
  resolveNewThreadModelSelectionOverride,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it.each([
    ["a new thread with a default account", true, false, true],
    ["a new thread whose account the user picked", true, true, false],
    ["an existing thread", false, false, false],
  ])("balances the account of %s: %s", (_name, isLocalDraftThread, explicit, expected) => {
    const draft = {
      activeProvider: PROJECT_DEFAULT_SELECTION.instanceId,
      modelSelectionByProvider: {
        [PROJECT_DEFAULT_SELECTION.instanceId]: PROJECT_DEFAULT_SELECTION,
      },
      modelSelectionExplicit: explicit,
    };
    expect(balancesNewThreadAccount(draft, isLocalDraftThread)).toBe(expected);
  });
});
