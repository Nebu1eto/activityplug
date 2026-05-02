import {
  ActivityPlugError,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type Post,
  type ReactPostInput,
  capability,
  createCapabilitySet,
} from "@activityplug/core";
import {
  clientFor,
  createMastodonBaseAdapter,
  requestVoid,
  tokenHeader,
  type MastodonBaseAdapterOptions,
  type MastodonTransportOptions,
} from "@activityplug/mastodon-base";

export type PleromaAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  | "id"
  | "displayName"
  | "kind"
  | "supportedSoftware"
  | "supportsRefreshToken"
  | "supportsLocalVisibility"
>;

export function createPleromaAdapter(options: PleromaAdapterOptions = {}): ActivityPlugAdapter {
  const adapter = createMastodonBaseAdapter({
    ...options,
    id: "pleroma",
    displayName: "Pleroma",
    kind: "mastodon-compatible",
    supportedSoftware: ["pleroma", "akkoma"],
    supportsRefreshToken: true,
    supportsLocalVisibility: true,
  });
  return {
    ...adapter,
    metadata: {
      ...adapter.metadata,
      staticCapabilities: createCapabilitySet({
        ...adapter.metadata.staticCapabilities,
        "social.reaction": capability("supported"),
        "social.bookmarkFolders": capability(
          "unknown",
          "Pleroma bookmark folders are not exposed by the current public API surface.",
        ),
        "notifications.pleromaEmojiReaction": capability(
          "unknown",
          "Pleroma notification listing is reserved for a later ActivityPlug surface.",
        ),
        "notifications.pleromaChatMention": capability(
          "unknown",
          "Pleroma notification listing is reserved for a later ActivityPlug surface.",
        ),
      }),
    },
    social: {
      ...adapter.social,
      react: async (input, context) =>
        pleromaReaction(input, "PUT", "social.reaction", context, options, adapter),
      unreact: async (input, context) =>
        pleromaReaction(input, "DELETE", "social.unreaction", context, options, adapter),
    },
  };
}

export const pleromaAdapter = createPleromaAdapter();

async function pleromaReaction(
  input: ReactPostInput,
  method: "PUT" | "DELETE",
  operation: string,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
  adapter: ActivityPlugAdapter,
): Promise<Post> {
  await requestVoid(
    clientFor(context, options)(
      `api/v1/pleroma/statuses/${encodeURIComponent(input.postId)}/reactions/${encodeURIComponent(input.emoji)}`,
      {
        method,
        headers: await tokenHeader(input.session, context, operation),
      },
    ).then(() => undefined),
    operation,
    context,
  );
  const getPost = adapter.posts?.get;
  if (getPost === undefined) {
    throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Pleroma post lookup is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return getPost({ id: input.postId }, context);
}
