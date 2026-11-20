import { describe, expect, it } from "vite-plus/test";

import type { ThreadIsolationStatus } from "@t3tools/contracts";

import {
  pendingEdits,
  typedEntries,
  threadIsolationStatusText,
  threadNotIsolatedReason,
  threadStartedUnisolated,
  unisolatedChoice,
  withEntries,
} from "./ThreadIsolationPolicyFields";

describe("thread isolation lists", () => {
  it("adds a typed or picked folder whole, commas and spaces included", () => {
    expect(typedEntries("  /home/me/My Docs, 2024 ", "writableFolders")).toEqual([
      "/home/me/My Docs, 2024",
    ]);
    expect(typedEntries("C:\\Users\\me\\a,b", "readableFolders")).toEqual(["C:\\Users\\me\\a,b"]);
    expect(typedEntries("   ", "writableFolders")).toEqual([]);
  });

  it("splits typed hosts and variable names on spaces or commas", () => {
    expect(typedEntries("a.example:443 b.example:443,c.example:443", "hosts")).toEqual([
      "a.example:443",
      "b.example:443",
      "c.example:443",
    ]);
  });

  it("starts a thread's own list from the one in Settings, so nothing is dropped", () => {
    expect(withEntries(undefined, ["/a", "/b"], ["/picked"])).toEqual(["/a", "/b", "/picked"]);
    expect(withEntries(undefined, ["/a"], ["/a"])).toEqual(["/a"]);
    expect(withEntries(["/a"], ["/b"], ["/c", "/c"])).toEqual(["/a", "/c"]);
    expect(withEntries(["/a"], undefined, ["/a"])).toBeUndefined();
  });
});

describe("thread isolation status", () => {
  const windows = "on Windows, srt runs only Claude and Codex threads";
  const status: ThreadIsolationStatus = {
    backend: "srt",
    detail: "",
    srt: { notIsolated: { grok: windows, kiro: windows } },
    docker: { unavailable: "Docker is not running", notIsolated: {} },
  };

  it("names the sandbox in use and the providers it starts without isolation, by reason", () => {
    expect(threadIsolationStatusText(status)).toBe(
      `In use: srt. Without isolation: Grok, Kiro: ${windows}.`,
    );
    expect(
      threadIsolationStatusText({ ...status, backend: null, detail: "srt cannot be used here: x" }),
    ).toBe("Threads start without isolation: srt cannot be used here: x.");
    const docker = "Docker isolation needs the thread's folder to be a Git repository";
    expect(
      threadIsolationStatusText({
        ...status,
        srt: { notIsolated: {} },
        threads: { a: docker, b: docker },
      }),
    ).toBe(`In use: srt. Started without isolation: 2 threads: ${docker}.`);
    expect(threadStartedUnisolated({ ...status, threads: { a: docker } }, "a")).toBe(docker);
  });

  it("tells a thread why it starts without isolation under its own sandbox choice", () => {
    expect(threadNotIsolatedReason(status, "automatic", "claudeAgent")).toBeUndefined();
    expect(threadNotIsolatedReason(status, "automatic", "grok")).toBe(windows);
    expect(threadNotIsolatedReason(status, "docker", "claudeAgent")).toBe(
      "Docker cannot be used here: Docker is not running",
    );
  });
});

describe("threads that cannot be sandboxed", () => {
  it("starts them by default, as stored settings without the choice decode", () => {
    expect(unisolatedChoice(false)).toBe("start");
    expect(unisolatedChoice(true)).toBe("refuse");
  });
});

describe("isolation list edits", () => {
  const add = (entry: string) => (current: ReadonlyArray<string> | undefined) =>
    withEntries(current, undefined, [entry]) ?? current;

  it("applies a folder picked after a typed entry to the list that holds that entry", () => {
    const list = pendingEdits<ReadonlyArray<string> | undefined>(["/srv"]);
    list.edit(add("/a"));
    expect(list.edit(add("/picked"))).toEqual(["/srv", "/a", "/picked"]);
  });

  it("keeps an unconfirmed edit when the echo of an earlier one arrives", () => {
    const list = pendingEdits<ReadonlyArray<string> | undefined>(["/srv"]);
    list.edit(add("/a"));
    list.edit(add("/b"));
    // The server confirms the first write: the second, still in flight, stays shown.
    list.receive(["/srv", "/a"]);
    expect(list.current()).toEqual(["/srv", "/a", "/b"]);
    expect(list.edit(add("/c"))).toEqual(["/srv", "/a", "/b", "/c"]);
    // A value written elsewhere replaces the draft.
    list.receive(["/other"]);
    expect(list.current()).toEqual(["/other"]);
  });

  it("shows the server's value again when a write fails", () => {
    const list = pendingEdits<ReadonlyArray<string> | undefined>(["/srv"]);
    list.edit(add("/a"));
    list.fail();
    expect(list.current()).toEqual(["/srv"]);
    // The next edit does not carry the failed one with it.
    expect(list.edit(add("/b"))).toEqual(["/srv", "/b"]);
  });
});
