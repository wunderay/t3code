import { DEFAULT_COORDINATOR_LABELS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    execute:
      vi.fn<(request: { input: { type: string } }) => Promise<{ _tag: string; cause?: unknown }>>(),
    snapshot: {} as Record<string, unknown>,
    pending: false,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/coordinator", () => ({
  coordinatorEnvironment: { snapshot: () => ({}), command: { permissionAtom: () => ({}) } },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.pending
      ? null
      : {
          pause: { active: true },
          goals: [],
          cards: [],
          ...mocks.snapshot,
          configuration: {
            enabled: true,
            coordinatorPaused: false,
            coordinatorThreadId: "coordinator",
            coordinatorProjectId: null,
            coordinatorTitle: null,
            labels: DEFAULT_COORDINATOR_LABELS,
            ...(mocks.snapshot.configuration as object | undefined),
          },
        },
    error: null,
    isPending: mocks.pending,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.execute }));
vi.mock("./CoordinatorDashboard", () => ({
  CoordinatorDashboard: () => null,
  useCoordinatorDashboardEnabled: () => false,
}));
vi.mock("./CoordinatorSection", () => ({
  Field: () => null,
  MODES: [],
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));

const { MobileCoordinatorThreadBoundary } = await import("./CoordinatorThread");

it("shows its thread with what waits for the owner", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.execute.mockImplementation(() => Promise.resolve({ _tag: "Success" }));
  mocks.snapshot = {
    grantProposals: [
      {
        grant: { id: "grant", scope: { kind: "project", id: "p" }, folders: ["docs"] },
        reason: "Not named",
      },
    ],
    resultChecks: [
      { assignmentId: "work", base: "b", head: "h", passed: false, blocking: ["Outside: docs"] },
    ],
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MobileCoordinatorThreadBoundary environmentId="environment" threadId="coordinator">
        <p>chat</p>
      </MobileCoordinatorThreadBoundary>,
    ),
  );
  expect(container.textContent).toContain("Needs you · 2");
  expect(container.textContent).toContain("chat");
  expect(container.querySelector('[aria-label="Your desired outcome"]')).toBeNull();
  const dismiss = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Dismiss",
  )!;
  await act(async () => dismiss.click());
  expect(mocks.execute.mock.calls.at(-1)?.[0].input).toEqual({
    type: "grant.dismiss",
    grantId: "grant",
  });
  const release = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Release to merge",
  )!;
  await act(async () => release.click());
  expect(mocks.execute.mock.calls.at(-1)?.[0].input).toEqual({
    type: "result.accept",
    assignmentId: "work",
    head: "h",
  });
  // A refused action says why.
  mocks.execute.mockImplementation(() =>
    Promise.resolve({
      _tag: "Failure",
      cause: Cause.fail({ operation: "results.accept", reason: "policy", detail: "Held." }),
    }),
  );
  await act(async () => release.click());
  expect(container.textContent).toContain("Held.");
  mocks.snapshot = {};
  await act(async () => root.unmount());
});

it("renders a thread at once, with the permissions only where the Coordinator manages it", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const show = (threadId: string) =>
    act(async () =>
      root.render(
        <MobileCoordinatorThreadBoundary environmentId="environment" threadId={threadId}>
          <p>chat</p>
        </MobileCoordinatorThreadBoundary>,
      ),
    );
  mocks.pending = true;
  await show("coordinator");
  expect(container.textContent).toBe("chat");
  mocks.pending = false;
  await show("person");
  expect(container.textContent).toBe("chat");
  await show("coordinator:work");
  expect(container.textContent).toContain("permissions");
  expect(container.textContent).toContain("chat");
  // With other threads allowed, only one it has taken on gets the panel.
  mocks.snapshot = {
    configuration: { manageOtherThreads: true },
    cards: [{ id: "env:adopted", threadId: "adopted", assignmentId: "work" }],
  };
  await show("person");
  expect(container.textContent).toBe("chat");
  await show("adopted");
  expect(container.textContent).toContain("permissions");
  mocks.snapshot = {};
  await act(async () => root.unmount());
});

it("mounts the chat once while the snapshot arrives, on the Coordinator's own thread too", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let mounts = 0;
  const countMount = (node: HTMLElement | null) => {
    if (node) mounts += 1;
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const show = () =>
    act(async () =>
      root.render(
        <MobileCoordinatorThreadBoundary environmentId="environment" threadId="coordinator">
          <p ref={countMount}>chat</p>
        </MobileCoordinatorThreadBoundary>,
      ),
    );
  mocks.pending = true;
  await show();
  mocks.pending = false;
  mocks.snapshot = {
    grantProposals: [
      { grant: { id: "grant", scope: { kind: "project", id: "p" } }, reason: "Not named" },
    ],
  };
  await show();
  expect(container.textContent).toContain("Needs you");
  expect(mounts).toBe(1);
  mocks.snapshot = {};
  await act(async () => root.unmount());
});
