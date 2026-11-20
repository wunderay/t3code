import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** A provider process started in the thread's sandbox: run exactly this, with only this env. */
export interface AgentIsolationLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export class AgentIsolationError extends Schema.TaggedError<AgentIsolationError>()(
  "AgentIsolationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AgentIsolationShape {
  /**
   * The sandboxed launch of a thread's provider process, released when the scope closes;
   * undefined when it runs as it would without thread isolation (the setting is off, or this
   * provider or machine cannot be isolated, which the server reports).
   */
  readonly wrap: (input: {
    readonly provider: string;
    readonly threadId: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    /** The command is a shell's command line (a Windows .cmd or .bat), which no sandbox starts. */
    readonly shell?: boolean | undefined;
    /** Files T3 Code gives the provider besides its own folders, such as an extension. */
    readonly readable?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<AgentIsolationLaunch | undefined, AgentIsolationError, Scope.Scope>;
}

export const AgentIsolation = Context.Reference<AgentIsolationShape>(
  "@t3tools/shared/AgentIsolation",
  { defaultValue: () => ({ wrap: () => Effect.undefined }) },
);

/** The provider and thread an ACP runtime is started for; none for probes and sign-in. */
export const AgentIsolationTarget = Context.Reference<
  { readonly provider: string; readonly threadId: string } | undefined
>("@t3tools/shared/AgentIsolation/Target", { defaultValue: () => undefined });
