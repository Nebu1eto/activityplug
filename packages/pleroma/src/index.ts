import {
  ActivityPlugError,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type Post,
  type ReactPostInput,
  type TokenSet,
  capability,
  createCapabilitySet,
} from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type MastodonBaseAdapterOptions,
} from "@activityplug/mastodon-base";
import ky from "ky";

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
  options: HolloCompatiblePleromaOptions,
  adapter: ActivityPlugAdapter,
): Promise<Post> {
  await clientFor(context, options)(
    `api/v1/pleroma/statuses/${encodeURIComponent(input.postId)}/reactions/${encodeURIComponent(input.emoji)}`,
    {
      method,
      headers: await tokenHeader(input.session, context, operation),
    },
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

type HolloCompatiblePleromaOptions = Pick<PleromaAdapterOptions, "fetch" | "httpClient">;

async function tokenHeader(
  session: ReactPostInput["session"],
  context: AdapterOperationContext,
  operation: string,
): Promise<Record<string, string>> {
  const stored = await context.sessionStore?.get(session.id);
  if (stored === undefined || stored === null) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  if (stored.adapter !== context.adapterId || stored.origin !== context.origin) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session does not belong to this adapter.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  assertAccessTokenFresh(stored.tokenSet, context, operation);
  return {
    Authorization: `${stored.tokenSet.tokenType ?? "Bearer"} ${stored.tokenSet.accessToken}`,
  };
}

function assertAccessTokenFresh(
  tokenSet: TokenSet,
  context: AdapterOperationContext,
  operation: string,
): void {
  if (tokenSet.expiresAt === undefined) return;
  const accessTokenExpiresAt = Date.parse(tokenSet.expiresAt);
  if (!Number.isFinite(accessTokenExpiresAt) || accessTokenExpiresAt <= Date.now()) {
    throw new ActivityPlugError("AUTH_EXPIRED", "Auth session access token has expired.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
}

function clientFor(context: AdapterOperationContext, options: HolloCompatiblePleromaOptions) {
  return (
    options.httpClient ??
    ky.create({ prefix: context.origin, fetch: options.fetch, redirect: "manual" })
  );
}
