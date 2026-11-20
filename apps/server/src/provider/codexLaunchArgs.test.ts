import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

it("privacy mode disables optional Codex exports while preserving coding configuration", () => {
  const args = codexAppServerArgs(
    resolveCodexLaunchArgs('--config model=\\"gpt-6-luna\\"', {
      T3CODE_DISABLE_OPTIONAL_EGRESS: "true",
    }),
  );
  NodeAssert.ok(args.includes('model="gpt-6-luna"'));
  for (const value of [
    "analytics.enabled=false",
    "feedback.enabled=false",
    'otel.exporter="none"',
    "otel.log_user_prompt=false",
  ])
    NodeAssert.ok(args.includes(value));
});

describe("codexAppServerArgs", () => {
  it.each([
    {
      name: "preserves escaped TOML quotes in config values",
      launchArgs: String.raw`--config model=\"gpt-6.1-sol\" --strict-config`,
      expected: ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    },
    {
      name: "lets launch args override the unload delay",
      launchArgs: "-c thread_unload_delay_secs=1800",
      expected: ["-c", "thread_unload_delay_secs=1800"],
    },
  ])("asks Codex to unload unsubscribed threads immediately and $name", (row) => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(row.launchArgs), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      ...row.expected,
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("drops launch args that enable user hooks", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(
        "--enable hooks --enable=hooks --enable codex_hooks --enable=codex_hooks --enable foo --disable hooks",
      ),
      ["--enable", "foo", "--disable", "hooks"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("codex exec and mcp list launch args", () => {
  const launchArgs =
    "--strict-config --oss --local-provider ollama --profile local -p=work --listen off --enable foo";

  it("keeps the local model provider flags for codex exec", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), [
      "--strict-config",
      "--oss",
      "--local-provider",
      "ollama",
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });

  it("keeps the selected profile and drops exec-only flags for codex mcp list", () => {
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs), [
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });
});
