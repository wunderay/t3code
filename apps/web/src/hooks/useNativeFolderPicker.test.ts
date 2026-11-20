import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nativeFolderPickerTarget, pickedFolderPath } from "./useNativeFolderPicker";

const primary = EnvironmentId.make("primary");
const local = EnvironmentId.make("local-wsl");
const remote = EnvironmentId.make("remote");
const environmentOf = (connectionId: string, displayUrl: string | null) =>
  ({
    entry: { target: { _tag: "BearerConnectionTarget", connectionId } },
    displayUrl,
  }) as unknown as Parameters<typeof nativeFolderPickerTarget>[0]["environment"];
const base = {
  hasDesktopBridge: true,
  primaryEnvironmentId: primary,
  bootstraps: [{ id: "wsl:Ubuntu", httpBaseUrl: "http://127.0.0.1:4001", runningDistro: "Ubuntu" }],
};

describe("the native folder picker for isolation's folder fields", () => {
  it("opens for this machine's own environments, as adding a project does", () => {
    expect(
      nativeFolderPickerTarget({ ...base, environmentId: primary, environment: undefined }),
    ).toEqual({ target: null });
    expect(
      nativeFolderPickerTarget({
        ...base,
        environmentId: local,
        environment: environmentOf("local:wsl:Ubuntu", "http://127.0.0.1:4001"),
      }),
    ).toEqual({ target: "wsl:Ubuntu", distro: "Ubuntu" });
    // A folder picked in Windows on a WSL server is named as the server names it.
    expect(pickedFolderPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\shared", "ubuntu")).toEqual({
      path: "/home/me/shared",
    });
    expect(pickedFolderPath("/srv/shared", null)).toEqual({ path: "/srv/shared" });
  });

  it("refuses a picked folder that is not on the environment's machine", () => {
    expect(pickedFolderPath("\\\\wsl$\\Ubuntu\\home\\me", "Debian")).toEqual({
      problem: "That folder is in WSL's Ubuntu, not in Debian, where this environment runs.",
    });
    expect(pickedFolderPath("\\\\wsl$\\Ubuntu\\home\\me", null)).toEqual({
      problem: "That folder is in WSL's Ubuntu, not on this environment's machine.",
    });
    expect(pickedFolderPath("C:\\Users\\me", "Ubuntu")).toEqual({
      problem: "That folder is on Windows, not in WSL's Ubuntu, where this environment runs.",
    });
  });

  it("is not offered where the folder is not on this machine: typed instead", () => {
    expect(
      nativeFolderPickerTarget({
        ...base,
        hasDesktopBridge: false,
        environmentId: primary,
        environment: undefined,
      }),
    ).toBeUndefined();
    expect(
      nativeFolderPickerTarget({
        ...base,
        environmentId: remote,
        environment: environmentOf("remote:1", "https://example.test"),
      }),
    ).toBeUndefined();
  });
});
