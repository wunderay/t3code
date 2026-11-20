import type { CoordinatorCommand } from "@t3tools/contracts";

type Override = Extract<CoordinatorCommand, { readonly type: "override.set" }>["override"];

export function userOverrideParameters(override: Override) {
  return Object.values(override.selection).every((value) => value === null || value === undefined)
    ? { actor: "user" as const, clear: true, scope: override.scope }
    : { actor: "user" as const, override };
}

type Card = {
  readonly id: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly provider: string | null;
  readonly destination: string | null;
  readonly effort: string | null;
};
type Model = {
  readonly provider: string;
  readonly id: string;
  readonly names: ReadonlyArray<string>;
  readonly efforts: ReadonlyArray<string>;
};
const clean = (value: string) =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLocaleLowerCase();

/** Recognize only a complete explicit user directive. A model's output never supplies its authority. */
export function resolveUserOverride(input: {
  readonly purpose: string;
  readonly authorizedScope: ReadonlyArray<string>;
  readonly cards: ReadonlyArray<Card>;
  readonly models: ReadonlyArray<Model>;
}):
  | { readonly type: "none" }
  | { readonly type: "needs-details"; readonly message: string }
  | {
      readonly type: "resolved";
      readonly card: Card;
      readonly model: string;
      readonly effort: string | null;
    } {
  if (!/^\s*(?:please\s+)?use\s+(?:model\s+)?/i.test(input.purpose)) return { type: "none" };
  const explicitModel = /^\s*(?:please\s+)?use\s+model\s+/i.test(input.purpose);
  const match =
    /^\s*(?:please\s+)?use\s+(?:model\s+)?(.+?)(?:\s+with\s+(?:effort|reasoning(?:\s+effort)?)\s+([\w-]+))?\s+for\s+(.+?)\s*[.!]?\s*$/i.exec(
      input.purpose,
    );
  if (!match)
    return explicitModel
      ? {
          type: "needs-details",
          message:
            "Use model <exact ID or advertised title> [with effort <option>] for <unique thread ID or title>.",
        }
      : { type: "none" };
  if (
    !explicitModel &&
    !input.models.some((model) =>
      [model.id, ...model.names].some((name) => clean(name) === clean(match[1]!)),
    )
  )
    return { type: "none" };
  const target = clean(match[3]!);
  const withoutRole = target.replace(/^thread\s+/, "");
  const cards = input.cards.filter((card) =>
    [clean(card.threadId), clean(card.id), clean(card.purpose)].some(
      (name) => name === target || name === withoutRole,
    ),
  );
  if (cards.length !== 1)
    return {
      type: "needs-details",
      message: "The target thread is missing or ambiguous. Use its exact thread ID.",
    };
  const card = cards[0]!;
  if (
    !input.authorizedScope.some((id) =>
      [card.id, card.threadId, card.environmentId, card.projectId].includes(id),
    )
  )
    return {
      type: "needs-details",
      message: "The target thread is outside this user goal's authorized scope.",
    };
  const models = input.models.filter(
    (model) =>
      model.provider === card.provider &&
      [model.id, ...model.names].some((name) => clean(name) === clean(match[1]!)),
  );
  if (models.length !== 1)
    return {
      type: "needs-details",
      message:
        "The model is missing or ambiguous on this thread's provider. Choose its exact advertised model ID; provider, account, and destination stay selected.",
    };
  const model = models[0]!;
  const requested = match[2] ? clean(match[2]) : card.effort;
  const effort =
    requested === null ? null : model.efforts.find((value) => clean(value) === clean(requested));
  if (effort === undefined)
    return {
      type: "needs-details",
      message: "Choose an exact effort option supported by the requested model.",
    };
  return { type: "resolved", card, model: model.id, effort };
}
