import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const CLI_TIMEOUT = "60 seconds";

/** One way the provider's own CLI signs in: in a terminal, or with a secret piped to its stdin. */
export interface CliLoginMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly args: ReadonlyArray<string>;
  readonly stdinField?: { readonly name: string; readonly label: string };
}

/**
 * Sign-in for a provider whose CLI keeps its login in a config folder (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`): runs that CLI's own login and logout on this environment for the folder.
 */
export const makeCliLoginAuth = Effect.fn("makeCliLoginAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Instances on the same folder share one login. */
  readonly configDir: string;
  readonly methods: ReadonlyArray<CliLoginMethod>;
  readonly logoutArgs: ReadonlyArray<string>;
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const available = options.methods.filter(
    (method) => method.stdinField !== undefined || Option.isSome(pty),
  );
  const methods: ReadonlyArray<ProviderAuthMethod> = available.map((method) => ({
    id: method.id,
    name: method.name,
    description: method.description,
    type: method.stdinField ? "credentials" : "terminal",
  }));

  const run = Effect.fnUntraced(
    function* (operation: string, args: ReadonlyArray<string>, stdin?: string) {
      const resolved = yield* resolveSpawnCommand(options.command, args, { env: options.env });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: options.cwd,
            env: options.env,
            shell: resolved.shell,
            stdin: stdin === undefined ? "ignore" : "pipe",
            stdout: "ignore",
            forceKillAfter: "2 seconds",
            stderr: "ignore",
          }),
        )
        .pipe(
          Effect.mapError((cause) => failure(operation, "Could not run the provider CLI.", cause)),
        );
      if (stdin !== undefined)
        yield* Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
          Effect.mapError((cause) => failure(operation, "Could not run the provider CLI.", cause)),
        );
      return yield* child.exitCode.pipe(
        Effect.mapError((cause) => failure(operation, "Could not run the provider CLI.", cause)),
      );
    },
    // Logout runs under the server-wide credential lock, so a CLI that never exits must not hold it.
    (effect, operation) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: CLI_TIMEOUT,
          orElse: () =>
            Effect.fail(failure(operation, "The provider CLI did not finish in time. Try again.")),
        }),
      ),
    // Closing the scope after a timeout kills the child.
    Effect.scoped,
  );

  const authenticate = Effect.fn("CliLoginAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const method = available.find((candidate) => candidate.id === methodId);
    if (!method) return yield* failure("start", "This sign-in method is not available here.");
    yield* fileSystem
      .makeDirectory(options.configDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not create this account's config folder.", cause),
        ),
      );
    let exitCode: number;
    if (method.stdinField) {
      const field = method.stdinField;
      const value = yield* Deferred.make<string>();
      yield* context.setInteraction(
        {
          type: "credentials",
          id: "credentials",
          fields: [{ name: field.name, label: field.label, secret: true }],
        },
        (response) =>
          response.type === "credentials" && response.values[field.name]?.trim()
            ? Deferred.succeed(value, response.values[field.name]!.trim()).pipe(Effect.asVoid)
            : Effect.fail(failure("respond", `Enter the ${field.label}.`)),
      );
      const secret = yield* Deferred.await(value);
      yield* context.verifying;
      exitCode = yield* run("start", method.args, secret);
    } else {
      if (Option.isNone(pty))
        return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
      exitCode = yield* ProviderAuthFlow.runTerminal({
        pty: pty.value,
        command: options.command,
        args: method.args,
        cwd: options.cwd,
        env: options.env,
        context,
        failure,
      });
      yield* context.verifying;
    }
    if (exitCode !== 0)
      return yield* failure("start", "The provider's sign-in command did not finish successfully.");
    yield* options.onChanged(true);
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `cli:${options.configDir}` },
    methods: Effect.succeed(methods),
    authenticate,
    logout: run("logout", options.logoutArgs).pipe(
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? options.onChanged(false)
          : Effect.fail(failure("logout", "The provider's sign-out command failed.")),
      ),
    ),
  });
});
