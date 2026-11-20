import { DEFAULT_COORDINATOR_LABELS, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { CoordinatorOwnerPanel, DangerLifts } from "./CoordinatorBoardSettings";
import { CoordinatorForm, Grants, NeedsYou } from "./CoordinatorSettings";

const mocks = vi.hoisted(() => ({ board: vi.fn(), execute: vi.fn(), pick: vi.fn() }));

vi.mock(import("../../state/coordinator"), () => ({
  coordinatorEnvironment: {
    board: mocks.board,
    snapshot: () =>
      Atom.make(
        AsyncResult.success({
          configuration: { enabled: false, labels: DEFAULT_COORDINATOR_LABELS },
          pause: { active: false },
          goals: [],
          cards: [],
          overrides: [],
          catalog: [],
          permissions: [],
        }),
      ),
    command: { permissionAtom: () => Atom.make(true) },
  } as never,
}));
vi.mock(
  import("../../state/use-atom-command"),
  () => ({ useAtomCommand: () => mocks.execute }) as never,
);

vi.mock(import("../../hooks/useNativeFolderPicker"), () => ({
  useNativeFolderPicker: () => mocks.pick,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProject: () => ({ workspaceRoot: "/repo/web" }) as never,
}));

const board = {
  weights: { use: 1, time: 1 },
  limits: { inFlight: null, perLogin: null, localSlots: null },
  budgets: [],
  today: [],
  merged: [{ goalId: "export", purpose: "Export the report" }],
  kept: [],
  unresolved: [],
};

function setup(result: AsyncResult.AsyncResult<unknown, never> = AsyncResult.initial(true)) {
  mocks.board.mockReset();
  mocks.board.mockReturnValue(Atom.make(result));
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue({ _tag: "Success" });
}

describe("CoordinatorOwnerPanel", () => {
  it("reads the board only once the owner opens the panel", async () => {
    setup();
    await using screen = await render(
      <CoordinatorOwnerPanel
        environmentId={EnvironmentId.make("local")}
        projects={[]}
        disabled={false}
        off={false}
        labels={DEFAULT_COORDINATOR_LABELS}
      />,
    );
    await expect
      .element(screen.getByText("Weights, limits, budgets, danger list and cloud runs to check"))
      .toBeVisible();
    expect(mocks.board).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByText("Weights, limits, budgets, danger list and cloud runs to check"),
    );
    await expect.element(screen.getByText("Loading routing and budgets…")).toBeVisible();
    expect(mocks.board).toHaveBeenCalled();
  });

  it("says the Coordinator is off and keeps its controls disabled", async () => {
    setup(AsyncResult.success(board));
    await using screen = await render(
      <CoordinatorOwnerPanel
        environmentId={EnvironmentId.make("local")}
        projects={[]}
        disabled={false}
        off
        labels={DEFAULT_COORDINATOR_LABELS}
      />,
    );
    await userEvent.click(
      screen.getByText("Weights, limits, budgets, danger list and cloud runs to check"),
    );
    await expect
      .element(screen.getByText("The Conductor is off; these can be set once it is on."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Revert…" })).toBeDisabled();
  });

  it("reverts a merged goal only once the owner confirms what it opens", async () => {
    setup(AsyncResult.success(board));
    await using screen = await render(
      <CoordinatorOwnerPanel
        environmentId={EnvironmentId.make("local")}
        projects={[]}
        disabled={false}
        off={false}
        labels={DEFAULT_COORDINATOR_LABELS}
      />,
    );
    await userEvent.click(
      screen.getByText("Weights, limits, budgets, danger list and cloud runs to check"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Revert…" }));
    await expect.element(screen.getByText("Revert this goal?")).toBeVisible();
    expect(mocks.execute).not.toHaveBeenCalled();
    // The dialog's inert layer covers the page for pointer events; press the button directly.
    await act(async () => {
      [...document.querySelectorAll('[role="alertdialog"] button')]
        .find((button) => button.textContent?.trim() === "Open revert pull requests")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.execute).toHaveBeenCalledWith({
      environmentId: "local",
      input: { type: "goal.revert", goalId: "export" },
    });
  });
});

describe("DangerLifts", () => {
  it("lists the danger rules none ticked, reading the board only once opened", async () => {
    setup(
      AsyncResult.success({
        ...board,
        danger: [
          { id: "force-push", label: "A force push", words: ["git", "push", "--force"] },
          { id: "permission", label: "A change of permissions" },
        ],
      }),
    );
    const onChange = vi.fn();
    await using screen = await render(
      <DangerLifts environmentId={EnvironmentId.make("local")} lifts={[]} onChange={onChange} />,
    );
    expect(mocks.board).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Danger list rules to lift for this grant · 0"));
    await expect.element(screen.getByLabelText("A force push")).not.toBeChecked();
    await expect.element(screen.getByLabelText("A change of permissions")).not.toBeChecked();
    await expect.element(screen.getByText("git push --force")).toBeVisible();
    await expect
      .element(screen.getByLabelText("A force push"))
      .toHaveAccessibleDescription("git push --force");
    await userEvent.click(screen.getByLabelText("A force push"));
    expect(onChange).toHaveBeenCalledWith(["force-push"]);
  });
});

describe("NeedsYou", () => {
  it("shows all the authority a proposed grant carries and sends that grant", async () => {
    setup();
    const grant = {
      id: "g1",
      scope: { kind: "project" as const, id: "web" },
      folders: ["src"],
      delete: ["dist"],
      maxAccess: 2 as const,
      lifts: ["force-push"],
      expiresAt: Date.UTC(2026, 11, 1, 9, 30),
    };
    await using screen = await render(
      <NeedsYou
        environmentId={EnvironmentId.make("local")}
        data={
          {
            cards: [],
            projects: [{ id: "web", title: "Web" }],
            grantProposals: [{ grant, reason: "To publish the build" }],
          } as never
        }
      />,
    );
    await expect
      .element(
        screen.getByText(
          "Web; folders src; may delete dist; lifts force-push; full access; until 2026-12-01 09:30 UTC",
        ),
      )
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Grant" }));
    expect(mocks.execute).toHaveBeenCalledWith({
      environmentId: "local",
      input: { type: "grant.set", grant },
    });
  });
});

describe("Grants", () => {
  it("grants each picked folder, relative to the project, and refuses one outside it", async () => {
    setup();
    await using screen = await render(
      <Grants
        environmentId={EnvironmentId.make("local")}
        data={
          {
            projects: [{ id: "web", title: "Web" }],
            configuration: { labels: DEFAULT_COORDINATOR_LABELS },
          } as never
        }
        disabled={false}
        send={async (input) => {
          await mocks.execute({ environmentId: "local", input });
          return true;
        }}
      />,
    );
    using toast = vi.spyOn(toastManager, "add");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Project" }), "web");
    const browse = screen.getByRole("button", { name: "Browse for granted folders" });
    for (const picked of ["/repo/web/src", "/repo/web", "/repo/other"]) {
      mocks.pick.mockResolvedValueOnce(picked);
      await userEvent.click(browse);
    }
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "/repo/other is outside the project folder /repo/web.",
        }),
      ),
    );
    await expect
      .element(screen.getByRole("list", { name: "Granted folders" }))
      .toHaveTextContent("src.");
    await userEvent.click(screen.getByRole("button", { name: "Make grant" }));
    expect(mocks.execute).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        type: "grant.set",
        grant: expect.objectContaining({ folders: ["src", "."], delete: ["src", "."] }),
      },
    });
  });
});

describe("CoordinatorForm", () => {
  it("saves a given name with the stored plural when the hidden plural was cleared", async () => {
    setup();
    await using screen = await render(
      <CoordinatorForm environmentId={EnvironmentId.make("local")} />,
    );
    await userEvent.click(screen.getByText("Rename titles"));
    await userEvent.clear(screen.getByRole("textbox", { name: "Plural name" }));
    await userEvent.click(screen.getByRole("button", { name: "Given name (Claudia)" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Name", exact: true }), "Claudia");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(mocks.execute).toHaveBeenCalledWith({
      environmentId: "local",
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
    });
  });
});
