// An eval client, not server code: it calls a model API over HTTP.
// @effect-diagnostics globalFetch:off globalTimers:off
import * as Schema from "effect/Schema";
import { proxyConfig } from "./proxy.ts";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
export type Message =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text: string; readonly calls: ReadonlyArray<ToolCall> }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly text: string;
    };
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}
interface ModelRequest {
  readonly system: string;
  readonly messages: ReadonlyArray<Message>;
  readonly tools: ReadonlyArray<ToolSpec>;
}
interface ModelReply {
  readonly text: string;
  readonly calls: ReadonlyArray<ToolCall>;
  readonly tokens?: number;
}
/** Any model, behind any API: one request in, one reply out. */
export type Model = (request: ModelRequest) => Promise<ModelReply>;

/** Any OpenAI-compatible chat API: OpenAI, an open-weight server, or the shared proxy by default. */
export const chatEndpoint = (baseUrl: string | undefined, apiKeyEnv: string | undefined) =>
  baseUrl
    ? {
        url: baseUrl.replace(/\/$/, ""),
        headers: apiKeyEnv
          ? { Authorization: `Bearer ${process.env[apiKeyEnv] ?? ""}` }
          : ({} as Record<string, string>),
      }
    : proxyConfig();

const ChatReply = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optional(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
            }),
          ),
        ),
      }),
    }),
  ).check(Schema.isMinLength(1)),
  usage: Schema.optional(Schema.Struct({ total_tokens: Schema.optional(Schema.Number) })),
});
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ChatReply));

const chat = (system: string, messages: ReadonlyArray<Message>) => [
  { role: "system", content: system },
  ...messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.text }
      : message.role === "tool"
        ? { role: "tool", tool_call_id: message.callId, content: message.text }
        : {
            role: "assistant",
            content: message.text || null,
            ...(message.calls.length
              ? {
                  tool_calls: message.calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  })),
                }
              : {}),
          },
  ),
];

const parseArguments = (text: string): unknown => {
  try {
    return JSON.parse(text || "{}");
  } catch {
    // Left as text, so the host refuses it as a call it cannot decode.
    return text;
  }
};

export const chatModel =
  (
    endpoint: { readonly url: string; readonly headers: Record<string, string> },
    model: string,
  ): Model =>
  async ({ system, messages, tools }) => {
    const body = JSON.stringify({
      model,
      messages: chat(system, messages),
      tools: tools.map((tool) => ({ type: "function", function: tool })),
    });
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${endpoint.url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...endpoint.headers },
        body,
      }).catch((cause: unknown) => cause as Error);
      const transient =
        response instanceof Error || response.status === 429 || response.status >= 500;
      if (transient && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
        continue;
      }
      if (response instanceof Error) throw response;
      const text = await response.text();
      if (response.status !== 200) throw new Error(`Model API ${response.status}: ${text}`);
      const reply = decodeReply(text);
      const message = reply.choices[0]!.message;
      return {
        text: message.content ?? "",
        calls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        })),
        tokens: reply.usage?.total_tokens ?? 0,
      };
    }
  };
