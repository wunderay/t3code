import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const fake = vi.hoisted(() => ({
  phase: "waiting",
  mutate: vi.fn(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => ({ providerInstances: {} })) as never,
  usePersistEnvironmentProviderInstanceMutation: (() => fake.mutate) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: { phase: fake.phase }, error: null })) as never,
}));
vi.mock(import("./ProviderWizardAuthenticationStep"), async (original) => ({
  ...(await original()),
  ProviderWizardAuthenticationStep: () => <section aria-label="Sign-in step" />,
}));

import { AddProviderAccountDialog } from "./AddProviderAccountDialog";

function setup(phase: string) {
  fake.phase = phase;
  fake.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
}

async function openSignInStep(onClose: () => void) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <AddProviderAccountDialog
        environmentId={EnvironmentId.make("remote-device")}
        environmentLabel="Remote device"
        driver={ProviderDriverKind.make("claudeAgent")}
        onClose={onClose}
      />,
    ),
  );
  await userEvent.fill(
    document.querySelector<HTMLInputElement>('[aria-label="Account name"]')!,
    "Work",
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );
  await expect.element(screen.getByRole("region", { name: "Sign-in step" })).toBeInTheDocument();
  stack.move();
  return screen;
}

describe("AddProviderAccountDialog", () => {
  it("stays open on Escape and outside clicks, with no Close button, while sign-in runs", async () => {
    setup("waiting");
    const onClose = vi.fn();
    await using screen = await openSignInStep(onClose);
    expect(screen.container.ownerDocument.querySelector('[aria-label="Close"]')).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(document.body, { position: { x: 2, y: 2 } });
    expect(onClose).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("region", { name: "Sign-in step" })).toBeInTheDocument();
  });

  it("closes once on Escape when no sign-in runs", async () => {
    setup("idle");
    const onClose = vi.fn();
    await using _screen = await openSignInStep(onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
