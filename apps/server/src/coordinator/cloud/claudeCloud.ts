import { CoordinatorError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as ProcessRunner from "../../processRunner.ts";
import { type CloudDriver, type RemoteRun, git, withWorktree } from "./CloudDriver.ts";

const SESSION_URL = /https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_-])/;
const TRUST_PROMPT = "Yes, I trust this folder";
// The environment_kind of a session on Anthropic's cloud.
const CLOUD_KIND = "anthropic_cloud";
const MAX_CREDENTIALS = 64 * 1024;
const MAX_METADATA = 1024 * 1024;

const Credentials = Schema.fromJsonString(
  Schema.Struct({
    claudeAiOauth: Schema.optional(Schema.Struct({ accessToken: Schema.optional(Schema.String) })),
  }),
);
const SessionMetadata = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
  worker_status: Schema.optional(Schema.Unknown),
  environment_kind: Schema.optional(Schema.Unknown),
  config: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.Unknown),
      effort_level: Schema.optional(Schema.Unknown),
    }),
  ),
});
const SessionReply = Schema.fromJsonString(
  Schema.Struct({
    response_shape: Schema.optional(SessionMetadata),
    session: Schema.optional(SessionMetadata),
  }),
);

const decodeSessionReply = Schema.decodeOption(SessionReply);

/** Ended as the session's own metadata says: archived, failed, or its worker idle. */
const sessionEnded = (body: string) => {
  const reply = decodeSessionReply(body);
  const metadata =
    reply._tag === "Some" ? (reply.value.response_shape ?? reply.value.session) : undefined;
  return (
    metadata?.status === "archived" ||
    metadata?.status === "failed" ||
    metadata?.worker_status === "idle"
  );
};

/**
 * Why the session's own metadata does not prove the run's model and effort on Anthropic's
 * cloud, or undefined when it does. Fails closed on anything missing.
 */
const proofProblem = (run: RemoteRun, status: number, body: string) => {
  const sessionId = SESSION_URL.exec(run.handle)?.[1];
  if (!sessionId) return "the session URL carries no session id";
  if (status !== 200) return `the session metadata request returned HTTP ${status}`;
  const reply = decodeSessionReply(body);
  const metadata =
    reply._tag === "Some" ? (reply.value.response_shape ?? reply.value.session) : undefined;
  if (!metadata) return "the response holds no session metadata";
  if (metadata.id !== `cse_${sessionId.slice("session_".length)}`)
    return `the metadata id does not match session ${sessionId}`;
  const wrong = [
    ["environment", metadata.environment_kind, CLOUD_KIND],
    ["model", metadata.config?.model, run.model],
    ["effort", metadata.config?.effort_level, run.effort],
  ].filter(([, seen, expected]) => !expected || seen !== expected);
  return wrong.length === 0
    ? undefined
    : `the session metadata shows ${wrong.map(([name, seen, expected]) => `${name} ${String(seen)} (expected ${String(expected)})`).join(", ")}`;
};

/** `claude --cloud` starts a session that pushes the branch itself; it needs a terminal. */
export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const pty = yield* PtyAdapter.PtyAdapter;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const ambient = environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");

  const readToken = Effect.fn("ClaudeCloud.readToken")(function* (configDir: string) {
    const file = path.join(configDir, ".credentials.json");
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (info._tag === "None" || Number(info.value.size) > MAX_CREDENTIALS) return undefined;
    const credentials = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeEffect(Credentials)), Effect.option);
    return credentials._tag === "Some"
      ? credentials.value.claudeAiOauth?.accessToken?.trim() || undefined
      : undefined;
  });

  const readMetadata = Effect.fn("ClaudeCloud.readMetadata")(function* (
    sessionId: string,
    token: string,
  ) {
    const response = yield* http
      .execute(
        HttpClientRequest.get(`https://api.anthropic.com/v1/code/sessions/${sessionId}`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${token}`,
            "anthropic-version": "2023-06-01",
            "anthropic-client-platform": "claude_code_cli",
          }),
        ),
      )
      // The token must never follow a redirect; a redirect is no proof.
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const body = yield* response.text;
    return { status: response.status, body: body.length > MAX_METADATA ? "" : body };
  }, Effect.timeout("30 seconds"));

  return {
    submit: Effect.fn("ClaudeCloud.submit")(function* (input) {
      if (!input.model || !input.effort)
        return yield* new CoordinatorError({ operation: "claude-cloud-launch", reason: "invalid" });
      const { model, effort } = input;
      const env: NodeJS.ProcessEnv = {
        ...environment,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...(input.login ? { CLAUDE_CONFIG_DIR: input.login } : {}),
      };
      delete env.CCR_FORCE_BUNDLE;
      delete env.CCR_ENABLE_BUNDLE;
      // A brief that starts with "-" would otherwise parse as an option.
      const brief = input.brief.startsWith("-") ? `Task:\n${input.brief}` : input.brief;
      const output = yield* withWorktree(runner, fs, input.repository, input.base, (folder) =>
        Effect.gen(function* () {
          const child = yield* pty
            .spawn({
              shell: "claude",
              args: [
                "--ref",
                input.base,
                "--model",
                model,
                "--effort",
                effort,
                "--cloud",
                `${brief}\n\nCommit your work and push it to the branch ${input.branch}.`,
              ],
              cwd: folder,
              cols: 200,
              rows: 50,
              env,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new CoordinatorError({
                    operation: "claude-cloud-launch",
                    reason: "transport",
                    cause,
                  }),
              ),
            );
          const ready = yield* Deferred.make<void>();
          let text = "";
          let trusted = false;
          const stopData = child.onData((data) => {
            text += data;
            // The folder is a fresh worktree made for this launch; trust it once.
            if (!trusted && text.includes(TRUST_PROMPT)) {
              trusted = true;
              child.write("\x1b[B");
              child.write("\r");
            }
            if (text.includes("--teleport")) Deferred.doneUnsafe(ready, Exit.void);
          });
          const stopExit = child.onExit(() => Deferred.doneUnsafe(ready, Exit.void));
          yield* Deferred.await(ready).pipe(
            Effect.timeout("180 seconds"),
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                stopData();
                stopExit();
                child.kill();
              }),
            ),
          );
          return text;
        }),
      );
      const url = SESSION_URL.exec(output)?.[0];
      if (!url)
        return yield* new CoordinatorError({
          operation: "claude-cloud-launch",
          reason: "destination",
        });
      return url;
    }),
    ended: Effect.fn("ClaudeCloud.ended")(function* (run) {
      const sessionId = SESSION_URL.exec(run.handle)?.[1];
      const token = sessionId ? yield* readToken(run.login ?? ambient) : undefined;
      if (!sessionId || !token) return false;
      const metadata = yield* readMetadata(sessionId, token).pipe(
        Effect.mapError(
          (cause) =>
            new CoordinatorError({ operation: "claude-cloud-status", reason: "transport", cause }),
        ),
      );
      return metadata.status === 200 && sessionEnded(metadata.body);
    }),
    collect: Effect.fn("ClaudeCloud.collect")(function* (run) {
      const sessionId = SESSION_URL.exec(run.handle)?.[1];
      const token = sessionId ? yield* readToken(run.login ?? ambient) : undefined;
      // An unanswered metadata request is retried; everything else is final.
      const metadata =
        sessionId && token
          ? yield* readMetadata(sessionId, token).pipe(
              Effect.mapError(
                (cause) =>
                  new CoordinatorError({
                    operation: "claude-cloud-proof",
                    reason: "transport",
                    cause,
                  }),
              ),
            )
          : undefined;
      const problem = metadata
        ? proofProblem(run, metadata.status, metadata.body)
        : sessionId
          ? "no Claude login token, so the session metadata cannot be read"
          : "the session URL carries no session id";
      yield* git(runner, run.repository, ["fetch", "origin", `refs/heads/${run.branch}`]);
      const head = (yield* git(runner, run.repository, ["rev-parse", "FETCH_HEAD"])).trim();
      if (!problem) return { head };
      // Kept here, gone from origin, so an unproven head can never be merged from there.
      yield* git(runner, run.repository, [
        "update-ref",
        `refs/t3/refused/${run.branch}`,
        head,
      ]).pipe(
        Effect.andThen(
          git(runner, run.repository, [
            "push",
            `--force-with-lease=refs/heads/${run.branch}:${head}`,
            "origin",
            `:refs/heads/${run.branch}`,
          ]),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("A refused Claude cloud head is still on origin", {
            branch: run.branch,
            cause,
          }),
        ),
      );
      return {
        refused: `Claude cloud session ${run.handle} pushed ${run.branch}, but the head is refused: ${problem}`,
      };
    }),
  } satisfies CloudDriver;
});
