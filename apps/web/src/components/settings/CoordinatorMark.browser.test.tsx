import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_COORDINATOR_LABELS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// The fake environment serves no Coordinator: its snapshot names the first thread as its own.
vi.mock(import("../../state/coordinator"), () => ({
  coordinatorEnvironment: {
    snapshot: () =>
      Atom.make(
        AsyncResult.success({
          configuration: {
            enabled: true,
            coordinatorThreadId: "coordinator-lead",
            labels: DEFAULT_COORDINATOR_LABELS,
            manageOtherThreads: false,
          },
          cards: [],
          assignments: [],
          grants: [],
        }),
      ),
  } as never,
}));
vi.mock(import("./CoordinatorSettings"), () => ({
  NeedsYou: () => null,
  ThreadPermissions: () => <></>,
  PauseControl: () => null,
}));

const marks = (within: Element | null) => within?.querySelectorAll(".lucide-waypoints").length;

it("marks the Coordinator's thread in its empty state, header and row, and no other", async () => {
  const [coordinator, ordinary] = [
    threadWithHistory("coordinator-lead", 0),
    threadWithHistory("ordinary", 0),
  ];
  using _environment = installFakeEnvironment([coordinator, ordinary]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const open = async (threadId: string) => {
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
    );
    await router.load();
    // AppRoot brings its own router.
    return render(<AppRoot router={router} />, { router: false });
  };
  const header = (title: string) =>
    document.querySelector(`[aria-label="Thread actions for ${title}"]`);
  const row = (threadId: string) =>
    document.querySelector(`[data-thread-item="${ENVIRONMENT_ID}:${threadId}"]`);

  {
    await using _app = await open(coordinator.id);
    await expect
      .element(page.getByRole("heading", { name: "What should the Conductor take on?" }))
      .toBeVisible();
    expect(marks(page.getByRole("heading", { level: 1 }).element().parentElement)).toBe(1);
    await vi.waitFor(() => expect(marks(header(coordinator.title))).toBe(1));
    await vi.waitFor(() => expect(marks(row(coordinator.id))).toBe(1));
    expect(marks(row(ordinary.id))).toBe(0);
  }
  await using _app = await open(ordinary.id);
  await vi.waitFor(() => expect(header(ordinary.title)).not.toBeNull());
  expect(marks(header(ordinary.title))).toBe(0);
  expect(document.body.textContent).not.toContain("take on?");
  expect(marks(row(ordinary.id))).toBe(0);
  expect(marks(row(coordinator.id))).toBe(1);
});
