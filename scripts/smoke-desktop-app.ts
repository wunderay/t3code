// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { CoordinatorSnapshot } from "@t3tools/contracts";
import { _electron, type ElectronApplication } from "playwright-core";

// A snapshot from an older build on purpose: the packaged server must migrate it forward, as it
// does for every upgrading user. It holds one project and two threads, nothing else.
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const STEP_TIMEOUT_MS = 60_000;

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    // An unpackaged app directory for a plain Electron executable, as PR CI runs it.
    app: { type: "string" },
    "artifacts-dir": { type: "string" },
    "capture-success": { type: "boolean", default: false },
    "coordinator-guidance": { type: "boolean", default: false },
  },
});
const executable = values.executable;
if (!executable)
  throw new Error(
    "Usage: smoke-desktop-app.ts --executable <app> [--app <dir>] [--artifacts-dir <dir>]",
  );
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-launch-"));
const t3Home = NodePath.join(home, "t3");
const supervisorDatabase = NodePath.join(t3Home, "userdata/coordinator.sqlite");
NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
NodeFS.copyFileSync(FIXTURE_DB, NodePath.join(t3Home, "userdata/statev2.sqlite"));

const nativeRequest = (method: string, params: Record<string, unknown>) => {
  const companion = NodePath.join(
    NodePath.dirname(executable),
    "resources/coordinator",
    HostProcess.Platform.defaultValue() === "win32" ? "t3-coordinator.exe" : "t3-coordinator",
  );
  const response = NodeChildProcess.spawnSync(companion, ["--database", supervisorDatabase], {
    encoding: "utf8",
    windowsHide: true,
    timeout: STEP_TIMEOUT_MS,
    input: `${JSON.stringify({ id: "desktop-ui-check", protocolVersion: 1, method, params })}\n`,
  });
  if (response.error) throw response.error;
  if (response.status !== 0) throw new Error(`Coordinator ${method} exited ${response.status}.`);
  const reply: { error?: unknown; result?: unknown } = JSON.parse(response.stdout.trim());
  if (reply.error || !reply.result) throw new Error(`Coordinator ${method} failed.`);
  return reply.result;
};

let step = "launching the app";
let app: ElectronApplication | undefined;
try {
  if (values["coordinator-guidance"]) {
    step = "seeding the disabled coordinator fixture";
    nativeRequest("configure", {
      actor: "user",
      enabled: false,
      coordinatorPaused: true,
      coordinatorThreadId: "coordinator-ui-check",
    });
    nativeRequest("overrides.set", {
      actor: "user",
      override: {
        id: "ui-global-pin",
        scope: { kind: "global", id: null },
        selection: { model: "ui-global-model" },
      },
    });
  }
  step = "launching the app";
  app = await _electron.launch({
    executablePath: executable,
    // Linux CI runners do not allow the Chromium sandbox's user namespaces.
    args: [...(values.app ? [NodePath.resolve(values.app)] : []), "--no-sandbox"],
    // HOME stays real: on macOS a fake HOME has no login keychain, and safeStorage blocks the
    // main process on a keychain dialog. macOS keeps its Electron profile in the runner's HOME.
    env: {
      ...process.env,
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      XDG_DATA_HOME: NodePath.join(home, ".local/share"),
      T3CODE_HOME: t3Home,
      ...(values["coordinator-guidance"] ? { T3_COORDINATOR_DATABASE: supervisorDatabase } : {}),
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
    },
    timeout: STEP_TIMEOUT_MS,
  });
  // A backend that never starts leaves no window, or only the "could not start" window, so the
  // thread wait below fails either way and its screenshot shows the startup error.
  step = "waiting for the first window";
  const page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
  try {
    step = "expanding the settled fixture chats";
    const settled = page.getByTestId("sidebar-settled-shelf-toggle");
    await settled.waitFor({ timeout: STEP_TIMEOUT_MS });
    if ((await settled.getAttribute("aria-expanded")) === "false") await settled.click();
    step = `finding "${THREAD_TITLE}" in the sidebar`;
    const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
    await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
    step = "opening the thread";
    await thread.click();
    await page.getByText(THREAD_MESSAGE).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
      .catch(() => {});
    throw error;
  }
  if (values["capture-success"]) {
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    await page.screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 });
  }
  if (values["coordinator-guidance"]) {
    step = "opening coordinator guidance settings";
    const settings = new URL(page.url());
    // Electron uses hash history even when its document is served through the custom protocol.
    const route = new URL(settings.hash.slice(1) || "/", settings);
    const environmentId = route.pathname.split("/").filter(Boolean)[0];
    if (!environmentId) throw new Error("The seeded thread route has no environment ID.");
    route.pathname = "/settings/maintenance";
    route.search = new URLSearchParams({
      machine: decodeURIComponent(environmentId),
    }).toString();
    route.hash = "coordinator";
    settings.hash = `${route.pathname}${route.search}${route.hash}`;
    await page.goto(settings.href);
    const guidance = page.locator("#coordinator details").filter({
      has: page.locator("summary", { hasText: "Custom prompt and memory" }),
    });
    const openGuidance = async () => {
      await guidance.waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await guidance.getAttribute("open")) === null)
        await guidance.locator("summary").click({ timeout: STEP_TIMEOUT_MS });
      await guidance.getByLabel("Custom prompt (Markdown)").waitFor({ timeout: STEP_TIMEOUT_MS });
    };
    await openGuidance();
    const prompt = guidance.getByLabel("Custom prompt (Markdown)");
    const memory = guidance.getByLabel("Memory (Markdown)");
    const save = guidance.getByRole("button", { name: "Save prompt and memory", exact: true });
    const saved = guidance.getByRole("status").filter({ hasText: /^Saved\.$/ });
    const promptText = "# Guidance check\nDelegate implementation and review.";
    const memoryText = "# Memory check\nKeep completed work summarized.";
    step = "saving coordinator prompt and memory";
    await prompt.fill(promptText);
    await memory.fill(memoryText);
    await save.click();
    await saved.waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.reload();
    await openGuidance();
    if ((await prompt.inputValue()) !== promptText || (await memory.inputValue()) !== memoryText)
      throw new Error("Coordinator guidance did not persist after reload.");
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    await guidance.screenshot({ path: NodePath.join(artifactsDir, "guidance-saved.png") });
    step = "clearing stored coordinator guidance";
    await guidance.getByRole("button", { name: "Clear prompt draft", exact: true }).click();
    await guidance.getByRole("button", { name: "Clear memory draft", exact: true }).click();
    await save.click();
    await saved.waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.reload();
    await openGuidance();
    if ((await prompt.inputValue()) !== "" || (await memory.inputValue()) !== "")
      throw new Error("Cleared coordinator guidance returned after reload.");
    await guidance.screenshot({ path: NodePath.join(artifactsDir, "guidance-cleared.png") });
    console.log(
      "Coordinator guidance check passed: save, reload, clear, and reload without a provider turn.",
    );
    const overrides = page.locator("#coordinator details").filter({
      has: page.locator("summary", { hasText: "Manual model override" }),
    });
    const targetId = "ui-same-scoped-id";
    const checkpoints: Array<{
      stage: string;
      overrides: CoordinatorSnapshot["overrides"];
      effectiveModel: string | null;
    }> = [];
    const checkOverrides = (stage: string, expected: Record<string, string>, model: string) => {
      const snapshot = nativeRequest("snapshot", {}) as Pick<
        CoordinatorSnapshot,
        "configuration" | "overrides"
      >;
      if (snapshot.configuration.enabled || !snapshot.configuration.coordinatorPaused)
        throw new Error("Scoped override check unexpectedly enabled coordination.");
      if (
        snapshot.overrides.length !== Object.keys(expected).length ||
        snapshot.overrides.some(
          (item) => expected[`${item.scope.kind}:${item.scope.id ?? ""}`] !== item.selection.model,
        )
      )
        throw new Error(`Stored scoped overrides differ from the expected pins at ${stage}.`);
      const resolved = nativeRequest("overrides.resolve", {
        projectId: targetId,
        assignmentId: targetId,
      }) as { selection: { model?: string | null } };
      if (resolved.selection.model !== model)
        throw new Error(`Scoped override inheritance differs at ${stage}.`);
      checkpoints.push({
        stage,
        overrides: snapshot.overrides,
        effectiveModel: resolved.selection.model,
      });
    };
    const selectOverrideScope = async (scope: "project" | "assignment") => {
      await overrides.waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await overrides.getAttribute("open")) === null)
        await overrides.locator("summary").click();
      await overrides.getByLabel("Override scope").selectOption(scope);
      await overrides
        .getByLabel(scope === "project" ? "Project ID" : "Assignment ID")
        .fill(targetId);
    };
    const settingsSaved = page
      .locator("#coordinator")
      .getByRole("status")
      .filter({ hasText: /^Saved\.$/ });
    const globalPin = { "global:": "ui-global-model" };
    step = "saving a project model override through the app";
    await selectOverrideScope("project");
    await overrides.getByLabel("Model").fill("ui-project-model");
    await overrides.getByRole("button", { name: "Apply override", exact: true }).click();
    await settingsSaved.waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.reload();
    checkOverrides(
      "project saved after reload",
      { ...globalPin, [`project:${targetId}`]: "ui-project-model" },
      "ui-project-model",
    );
    step = "saving an assignment override with the same target ID";
    await selectOverrideScope("assignment");
    await overrides.getByLabel("Model").fill("ui-assignment-model");
    await overrides.getByRole("button", { name: "Apply override", exact: true }).click();
    await settingsSaved.waitFor({ timeout: STEP_TIMEOUT_MS });
    await overrides.screenshot({ path: NodePath.join(artifactsDir, "overrides-saved.png") });
    await page.reload();
    checkOverrides(
      "assignment saved after reload",
      {
        ...globalPin,
        [`project:${targetId}`]: "ui-project-model",
        [`assignment:${targetId}`]: "ui-assignment-model",
      },
      "ui-assignment-model",
    );
    step = "clearing only the assignment override through the app";
    await selectOverrideScope("assignment");
    await overrides.getByRole("button", { name: "Return to automatic", exact: true }).click();
    await settingsSaved.waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.reload();
    checkOverrides(
      "assignment cleared after reload",
      { ...globalPin, [`project:${targetId}`]: "ui-project-model" },
      "ui-project-model",
    );
    step = "clearing only the project override through the app";
    await selectOverrideScope("project");
    await overrides.getByRole("button", { name: "Return to automatic", exact: true }).click();
    await settingsSaved.waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.reload();
    checkOverrides("project cleared after reload", globalPin, "ui-global-model");
    await selectOverrideScope("project");
    await overrides.screenshot({ path: NodePath.join(artifactsDir, "overrides-cleared.png") });
    NodeFS.writeFileSync(
      NodePath.join(artifactsDir, "override-check.json"),
      JSON.stringify(checkpoints, null, 2),
      "utf8",
    );
    console.log(
      "Scoped override check passed: project/assignment persistence, precedence, and scoped clearing preserve the global pin.",
    );
  }
  console.log("Desktop launch check passed: the app opened and showed the seeded thread.");
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  await app
    ?.windows()[0]
    ?.screenshot({ path: NodePath.join(artifactsDir, "failure.png"), timeout: 10_000 })
    .catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast backend output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-20).join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  if (app) {
    // A hung app never finishes closing; kill it so the job does not wait for its timeout.
    // Playwright drops the process handle once the app closes, so read it first.
    const child = app.process();
    const closed = app.close().catch(() => {});
    await Promise.race([closed, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    child.kill("SIGKILL");
  }
  NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
