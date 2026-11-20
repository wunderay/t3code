import { DEFAULT_COORDINATOR_LABELS, EnvironmentId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";
import { IndexDraftLanding } from "../IndexDraftLanding";
import { CoordinatorLanding } from "./CoordinatorBoundary";

const project = {
  id: "project",
  environmentId: "local",
  title: "Project",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  drafts: [] as Array<unknown>,
  // The primary's connection phase, as an atom so a test can move it on.
  phase: null as unknown,
}));

vi.mock(import("../../state/coordinator"), () => ({
  coordinatorEnvironment: { snapshot: () => state.snapshot as never } as never,
}));

vi.mock(import("../../state/primaryEnvironment"), () => ({
  primaryEnvironmentIdAtom: Atom.make(EnvironmentId.make("local")) as never,
  themeEnvironmentIdAtom: Atom.make(null) as never,
}));

// Projects as a cached shell holds them before the connection opens.
vi.mock(import("../../state/entities"), () => ({
  readProject: () => project as never,
  useAllEnvironmentShellsBootstrapped: () => true,
  useProjects: () => [project] as never,
  useVisibleThreadShells: () => [],
}));

vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePrimaryEnvironment: () => ({ connection: { phase: usePhase() } }) as never,
}));

vi.mock(import("../../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => handleNewThread as never,
}));
const usePhase = () => useAtomValue(state.phase as Atom.Atom<string>);
const handleNewThread = (projectRef: unknown) => {
  state.drafts.push(projectRef);
  return new Promise<never>(() => {});
};

const snapshot = (enabled: boolean) =>
  AsyncResult.success({
    configuration: {
      enabled,
      coordinatorThreadId: "coordinator-lead:x",
      labels: DEFAULT_COORDINATOR_LABELS,
    },
  });

function setup(lastSeenOn: boolean | null, phase = "connected") {
  state.drafts = [];
  state.phase = Atom.make(phase);
  state.snapshot = Atom.make<unknown>(AsyncResult.initial(true));
  localStorage.removeItem("t3code:coordinator-on:local");
  if (lastSeenOn !== null)
    localStorage.setItem("t3code:coordinator-on:local", JSON.stringify(lastSeenOn));
  return state.snapshot as Atom.Writable<unknown>;
}

const landing = async (atom: Atom.Writable<unknown>, arrives: unknown) => {
  function Arrival() {
    const set = useAtomSet(atom);
    const connect = useAtomSet(state.phase as Atom.Writable<string>);
    return (
      <>
        <button type="button" onClick={() => set(arrives)}>
          arrive
        </button>
        <button type="button" onClick={() => connect("connected")}>
          connect
        </button>
      </>
    );
  }
  return render(
    <>
      <Arrival />
      <CoordinatorLanding>
        {(holdDraft) => <IndexDraftLanding holdDraft={holdDraft} />}
      </CoordinatorLanding>
    </>,
  );
};

describe("CoordinatorLanding", () => {
  it("last seen on, it starts no draft before the snapshot and opens the Coordinator's thread", async () => {
    const atom = setup(true);
    await using screen = await landing(atom, snapshot(true));
    await expect.element(screen.getByRole("button", { name: "arrive" })).toBeVisible();
    expect(state.drafts).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "arrive" }));
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/local/coordinator-lead%3Ax"),
    );
    expect(state.drafts).toEqual([]);
  });

  it("last seen on but now off, it starts the draft once the snapshot says so", async () => {
    const atom = setup(true);
    await using screen = await landing(atom, snapshot(false));
    await expect.element(screen.getByRole("button", { name: "arrive" })).toBeVisible();
    expect(state.drafts).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "arrive" }));
    await vi.waitFor(() => expect(state.drafts).toHaveLength(1));
  });

  it("last seen off, or never seen, it starts the draft without waiting for the snapshot", async () => {
    for (const lastSeenOn of [false, null]) {
      const atom = setup(lastSeenOn);
      await using _screen = await landing(atom, snapshot(false));
      await vi.waitFor(() => expect(state.drafts).toHaveLength(1));
    }
  });

  it("last seen on and connecting, it holds the draft 1.5 s from the start, not from connecting", async () => {
    const atom = setup(true, "connecting");
    using _timers = fakeTimers();
    await using screen = await landing(atom, snapshot(true));
    await vi.advanceTimersByTimeAsync(1_000);
    (screen.getByRole("button", { name: "connect" }).element() as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(400);
    expect(state.drafts).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(state.drafts).toHaveLength(1));
  });

  it("connecting, then connected with the Coordinator on, it opens its thread and no draft", async () => {
    const atom = setup(true, "connecting");
    await using screen = await landing(atom, snapshot(true));
    await userEvent.click(screen.getByRole("button", { name: "connect" }));
    await userEvent.click(screen.getByRole("button", { name: "arrive" }));
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/local/coordinator-lead%3Ax"),
    );
    expect(state.drafts).toEqual([]);
  });

  it("where the snapshot is not coming, it starts the draft at once", async () => {
    for (const phase of ["reconnecting", "offline", "error", "unsupported", "available"]) {
      const atom = setup(true, phase);
      await using _screen = await landing(atom, snapshot(true));
      await vi.waitFor(() => expect(state.drafts).toHaveLength(1));
    }
  });
});
