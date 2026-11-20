import { DEFAULT_COORDINATOR_LABELS } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    execute: vi.fn(() => Promise.resolve({ _tag: "Success" })),
    inputs: new Map<string, (value: string) => void>(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  TextInput: ({
    accessibilityLabel,
    onChangeText,
  }: {
    accessibilityLabel: string;
    onChangeText: (value: string) => void;
  }) => {
    mocks.inputs.set(accessibilityLabel, onChangeText);
    return null;
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "allowed" ? true : undefined),
}));
vi.mock("../../state/coordinator", () => ({
  coordinatorEnvironment: { snapshot: () => ({}), command: { permissionAtom: () => "allowed" } },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      pause: { active: false },
      goals: [],
      cards: [],
      overrides: [],
      catalog: [],
      permissions: [],
      configuration: {
        enabled: false,
        coordinatorPaused: false,
        coordinatorThreadId: null,
        coordinatorProjectId: null,
        coordinatorTitle: null,
        labels: DEFAULT_COORDINATOR_LABELS,
      },
    },
    error: null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.execute }));
vi.mock("./CoordinatorDashboard", () => ({ CoordinatorDashboardSwitch: () => null }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => undefined,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "id" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/SegmentedControl", () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: ReadonlyArray<{ value: string; label: string }>;
    onSelect: (value: string) => void;
  }) =>
    options.map((option) => (
      <button key={option.value} onClick={() => onSelect(option.value)}>
        {option.label}
      </button>
    )),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));

const { CoordinatorSection } = await import("./CoordinatorSection");

it("saves a given name with the stored plural when the hidden plural was cleared", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<CoordinatorSection environmentId={"environment" as never} />));
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === label,
    )!;
  await act(async () => mocks.inputs.get("Plural name")!(""));
  await act(async () => button("Given name (Claudia)").click());
  await act(async () => mocks.inputs.get("Name")!("Claudia"));
  expect(button("Save titles").disabled).toBe(false);
  await act(async () => button("Save titles").click());
  expect(mocks.execute).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: {
        type: "configure",
        configuration: {
          labels: {
            ...DEFAULT_COORDINATOR_LABELS,
            coordinatorSingular: "Claudia",
            coordinatorNameKind: "given",
          },
        },
      },
    }),
  );
  await act(async () => root.unmount());
});
