import { DEFAULT_COORDINATOR_LABELS, EnvironmentId } from "@t3tools/contracts";
import { useAtomSet } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { updateClientSettings } from "../../hooks/useSettings";
import { render } from "../../../test/render";
import "~/index.css";
import { use } from "react";
import {
  CoordinatorEmptyState,
  CoordinatorThreadBoundary,
  CoordinatorThreadLabels,
} from "./CoordinatorBoundary";

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  mounts: 0,
  boards: 0,
  // While set, the boundary reads this one atom, so a test can change what it holds.
  atom: null as unknown,
}));
// A ref callback that keeps its identity runs once per mount of the element.
const countMount = (node: HTMLElement | null) => {
  if (node) state.mounts += 1;
};

vi.mock(import("../../state/coordinator"), () => ({
  coordinatorEnvironment: {
    snapshot: () => (state.atom ?? Atom.make(state.snapshot as never)) as never,
    board: () => {
      state.boards += 1;
      return Atom.make(AsyncResult.initial(true));
    },
    command: { permissionAtom: () => Atom.make(true) },
  } as never,
}));

const enabled = (manageOtherThreads: boolean) =>
  AsyncResult.success({
    configuration: {
      enabled: true,
      coordinatorThreadId: "coordinator-lead:x",
      labels: DEFAULT_COORDINATOR_LABELS,
      manageOtherThreads,
    },
    // A person's thread the Coordinator took on: work is assigned there.
    cards: [{ id: "env:adopted", threadId: "adopted", assignmentId: "work" }],
    assignments: [],
    grants: [],
  });

function setup(snapshot: unknown) {
  state.snapshot = snapshot;
  state.mounts = 0;
  state.boards = 0;
  state.atom = null;
}

const show = (threadId: string) =>
  render(
    <CoordinatorThreadBoundary environmentId={EnvironmentId.make("local")} threadId={threadId}>
      <p>chat</p>
    </CoordinatorThreadBoundary>,
  );

describe("CoordinatorThreadBoundary", () => {
  it("shows the chat at once while the Coordinator's snapshot is on its way", async () => {
    setup(AsyncResult.initial(true));
    await using screen = await show("person");
    await expect.element(screen.getByText("chat")).toBeVisible();
    expect(document.body.textContent).not.toContain("Loading thread");
  });

  it("adds its permissions only to threads the Coordinator manages", async () => {
    setup(enabled(false));
    {
      await using screen = await show("person");
      await expect.element(screen.getByText("chat")).toBeVisible();
      expect(document.body.textContent).not.toContain("permissions for this thread");
    }
    await using screen = await show("coordinator:work");
    await expect.element(screen.getByText(/permissions for this thread/)).toBeVisible();
  });

  it("with other threads allowed, still leaves alone a thread it has not taken on", async () => {
    setup(enabled(true));
    {
      await using screen = await show("person");
      await expect.element(screen.getByText("chat")).toBeVisible();
      expect(document.body.textContent).not.toContain("permissions for this thread");
    }
    await using screen = await show("adopted");
    await expect.element(screen.getByText(/permissions for this thread/)).toBeVisible();
  });

  it("gives the chat on its own thread the full height and its labels, and others neither", async () => {
    setup(enabled(false));
    function Chat() {
      const labels = use(CoordinatorThreadLabels);
      return (
        <div data-testid="chat" className="flex-1">
          {labels?.coordinatorSingular ?? "ordinary"}
        </div>
      );
    }
    const at = (threadId: string) =>
      render(
        <div className="flex h-[600px] flex-col">
          <CoordinatorThreadBoundary
            environmentId={EnvironmentId.make("local")}
            threadId={threadId}
          >
            <Chat />
          </CoordinatorThreadBoundary>
        </div>,
      );
    {
      await using screen = await at("person");
      await expect.element(screen.getByText("ordinary")).toBeVisible();
    }
    await using screen = await at("coordinator-lead:x");
    await expect.element(screen.getByText("Conductor")).toBeVisible();
    // Its composer sits as low as on any thread: the chat is not shrunk to its content.
    expect(screen.getByTestId("chat").element().getBoundingClientRect().height).toBe(600);
  });

  it("opens on the name the owner set, read as a role or as a given name", async () => {
    {
      await using screen = await render(
        <CoordinatorEmptyState labels={DEFAULT_COORDINATOR_LABELS} />,
      );
      await expect
        .element(screen.getByRole("heading", { name: "What should the Conductor take on?" }))
        .toBeVisible();
      await expect.element(screen.getByText(/hands it to threads/)).toBeVisible();
    }
    await using screen = await render(
      <CoordinatorEmptyState
        labels={{
          ...DEFAULT_COORDINATOR_LABELS,
          coordinatorSingular: "Claudia",
          coordinatorNameKind: "given",
        }}
      />,
    );
    await expect
      .element(screen.getByRole("heading", { name: "What should Claudia take on?" }))
      .toBeVisible();
  });

  it("mounts the chat once while the snapshot arrives, on the Coordinator's own thread too", async () => {
    setup(AsyncResult.initial(true));
    const snapshot = Atom.make<unknown>(AsyncResult.initial(true));
    state.atom = snapshot;
    function Arrival() {
      const set = useAtomSet(snapshot);
      return (
        <button type="button" onClick={() => set(enabled(false))}>
          arrive
        </button>
      );
    }
    await using screen = await render(
      <>
        <Arrival />
        <CoordinatorThreadBoundary
          environmentId={EnvironmentId.make("local")}
          threadId="coordinator-lead:x"
        >
          <p ref={countMount}>chat</p>
        </CoordinatorThreadBoundary>
      </>,
    );
    await expect.element(screen.getByText("chat")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "arrive" }));
    // Its layout arrived around the chat without mounting it again.
    await vi.waitFor(() => expect(document.querySelector(".lg\\:flex-row")).not.toBeNull());
    expect(state.mounts).toBe(1);
  });

  it("treats the retained Coordinator thread as an ordinary chat once switched off", async () => {
    setup(AsyncResult.initial(true));
    const snapshot = Atom.make<unknown>(enabled(false));
    state.atom = snapshot;
    await updateClientSettings({ coordinatorDashboard: true });
    function Switch() {
      const set = useAtomSet(snapshot);
      const off = enabled(false);
      return (
        <button
          type="button"
          onClick={() =>
            set(
              AsyncResult.success({
                ...off.value,
                configuration: { ...off.value.configuration, enabled: false },
              }),
            )
          }
        >
          off
        </button>
      );
    }
    await using screen = await render(
      <>
        <Switch />
        <CoordinatorThreadBoundary
          environmentId={EnvironmentId.make("local")}
          threadId="coordinator-lead:x"
        >
          <p ref={countMount}>chat</p>
        </CoordinatorThreadBoundary>
      </>,
    );
    // The dashboard loads after its layout shows; its own query is not the one counted.
    await vi.waitFor(() => expect(state.boards).toBeGreaterThan(0));
    state.boards = 0;
    await userEvent.click(screen.getByRole("button", { name: "off" }));
    await vi.waitFor(() => expect(document.querySelector(".lg\\:flex-row")).toBeNull());
    expect(state.mounts).toBe(1);
    expect(state.boards).toBe(0);
    await updateClientSettings({ coordinatorDashboard: false });
  });
});
