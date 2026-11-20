import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CoordinatorCommand,
  CoordinatorGoal,
  CoordinatorGrantInput,
  coordinatorInText,
  CoordinatorLabels,
  coordinatorName,
  DEFAULT_COORDINATOR_LABELS,
} from "./coordinator.ts";

const decodeGoal = Schema.decodeSync(CoordinatorGoal);
const decodeCommand = Schema.decodeUnknownSync(CoordinatorCommand);
const decodeGrantInput = Schema.decodeUnknownSync(CoordinatorGrantInput);
const decodeLabels = Schema.decodeSync(CoordinatorLabels);

describe("CoordinatorGoal", () => {
  it("keeps the board's fields, so a goal saved back loses neither its paths nor its caps", () => {
    const goal = {
      id: "goal",
      purpose: "Ship it",
      projectId: "project",
      touches: ["apps/server/src/coordinator"],
      budgetMicros: 5_000_000,
      budgetSeconds: 3_600,
    };
    expect(decodeGoal(goal)).toEqual(goal);
  });
});

describe("CoordinatorCommand", () => {
  it("carries the owner's park time to the store", () => {
    const command = { type: "configure", configuration: { parkMinutes: 45 } };
    expect(decodeCommand(command)).toEqual(command);
  });

  it("carries the danger rules the owner lifts for a grant, and a grant stored without any", () => {
    const grant = { id: "grant", scope: { kind: "project", id: "project" } };
    const lifted = { type: "grant.set", grant: { ...grant, lifts: ["force-push"] } };
    expect(decodeCommand(lifted)).toEqual(lifted);
    expect(decodeCommand({ type: "grant.set", grant })).toEqual({ type: "grant.set", grant });
  });
});

describe("CoordinatorGrantInput", () => {
  it("drops a lift, so a grant the Coordinator records from a message never carries one", () => {
    const grant = { id: "grant", scope: { kind: "project", id: "project" }, lifts: ["force-push"] };
    expect(decodeGrantInput({ ownerMessageId: "message", grant }).grant).not.toHaveProperty(
      "lifts",
    );
  });
});

describe("coordinatorName", () => {
  it("is the title set in Settings, or the label while none is set", () => {
    expect(coordinatorName({ coordinatorTitle: "Lead", labels: DEFAULT_COORDINATOR_LABELS })).toBe(
      "Lead",
    );
    expect(coordinatorName({ coordinatorTitle: null, labels: DEFAULT_COORDINATOR_LABELS })).toBe(
      DEFAULT_COORDINATOR_LABELS.coordinatorSingular,
    );
  });
});

describe("coordinatorInText", () => {
  it("reads labels stored before the name kind existed as a role", () => {
    const { coordinatorNameKind: _, ...stored } = DEFAULT_COORDINATOR_LABELS;
    const labels = decodeLabels(stored);
    expect(labels).toEqual(stored);
    expect(coordinatorInText(labels)).toBe("the Conductor");
  });

  it("gives a role its article, capitalised to start a sentence, and a given name none", () => {
    const role = { ...DEFAULT_COORDINATOR_LABELS, coordinatorSingular: "Maestro" };
    expect(coordinatorInText(role)).toBe("the Maestro");
    expect(coordinatorInText(role, true)).toBe("The Maestro");
    const given = {
      ...role,
      coordinatorSingular: "Claudia",
      coordinatorNameKind: "given" as const,
    };
    expect(coordinatorInText(given)).toBe("Claudia");
    expect(coordinatorInText(given, true)).toBe("Claudia");
  });
});
