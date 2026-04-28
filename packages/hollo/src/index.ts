import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type Post,
  type ReactPostInput,
  type TokenSet,
} from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type MastodonBaseAdapterOptions,
} from "@activityplug/mastodon-base";
import ky, { HTTPError, TimeoutError } from "ky";

export type HolloAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  | "id"
  | "displayName"
  | "kind"
  | "supportedSoftware"
  | "supportsRefreshToken"
  | "supportsLocalVisibility"
>;

export function createHolloAdapter(options: HolloAdapterOptions = {}): ActivityPlugAdapter {
  const adapter = createMastodonBaseAdapter({
    ...options,
    id: "hollo",
    displayName: "Hollo",
    kind: "mastodon-compatible",
    supportedSoftware: ["hollo"],
    supportsRefreshToken: false,
    instanceEndpointRequired: false,
  });
  return {
    ...adapter,
    metadata: {
      ...adapter.metadata,
      staticCapabilities: createCapabilitySet({
        ...adapter.metadata.staticCapabilities,
        "polls.create": capability(
          "unsupported",
          "Hollo poll creation is not mapped by this adapter yet.",
        ),
        "accounts.relationships": capability(
          "unsupported",
          "Hollo relationship reads are not compatible with the Mastodon relationship API.",
        ),
        "posts.quote": capability(
          "unsupported",
          "Hollo quote creation is not mapped by this adapter yet.",
        ),
        "search.hashtags": capability(
          "unsupported",
          "Hollo hashtag search returns an empty upstream result set.",
        ),
        "social.reaction": capability("supported"),
        "timelines.hashtag": capability(
          "unsupported",
          "Hollo hashtag timelines are not mapped by this adapter yet.",
        ),
      }),
    },
    posts: {
      ...adapter.posts,
      create: async (input, context) => {
        if (input.poll !== undefined) {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo poll creation is not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "post.create",
              capability: "polls.create",
            },
          );
        }
        if (input.quoteOfId !== undefined) {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo quote creation is not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "post.create",
              capability: "posts.quote",
            },
          );
        }
        const create = adapter.posts?.create;
        if (create === undefined) {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo compose is not mapped.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "post.create",
          });
        }
        return create(input, context);
      },
    },
    search: {
      ...adapter.search,
      search: async (input, context) => {
        if (input.type === undefined || input.type === "hashtags") {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo hashtag search is not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: input.type === undefined ? "search" : "search.hashtags",
              capability: "search.hashtags",
            },
          );
        }
        const search = adapter.search?.search;
        if (search === undefined) {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo search is not mapped.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "search",
          });
        }
        return search(input, context);
      },
    },
    social: {
      ...adapter.social,
      relationship: async (_input, context) =>
        Promise.reject(
          new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo relationship reads are not compatible with the Mastodon relationship API.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "account.relationships",
              capability: "accounts.relationships",
            },
          ),
        ),
      react: async (input, context) =>
        holloReaction(input, "react", "social.reaction", context, options, adapter),
      unreact: async (input, context) =>
        holloReaction(input, "unreact", "social.unreaction", context, options, adapter),
    },
    timelines: {
      ...adapter.timelines,
      hashtag: async (_input, context) =>
        Promise.reject(
          new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo hashtag timelines are not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "timeline.hashtag",
              capability: "timelines.hashtag",
            },
          ),
        ),
    },
  };
}

export const holloAdapter = createHolloAdapter();

async function holloReaction(
  input: ReactPostInput,
  action: "react" | "unreact",
  operation: string,
  context: AdapterOperationContext,
  options: Pick<HolloAdapterOptions, "fetch" | "httpClient">,
  adapter: ActivityPlugAdapter,
): Promise<Post> {
  await requestVoid(
    clientFor(context, options)(
      `api/v1/statuses/${encodeURIComponent(input.postId)}/${action}/${encodeURIComponent(input.emoji)}`,
      {
        method: "POST",
        headers: await tokenHeader(input.session, context, operation),
      },
    ).then(() => undefined),
    context,
    operation,
  );
  const getPost = adapter.posts?.get;
  if (getPost === undefined) {
    throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo post lookup is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return getPost({ id: input.postId }, context);
}

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

function clientFor(
  context: AdapterOperationContext,
  options: Pick<HolloAdapterOptions, "fetch" | "httpClient">,
) {
  return (
    options.httpClient ??
    ky.create({ prefix: context.origin, fetch: options.fetch, redirect: "manual" })
  );
}

async function requestVoid(
  request: Promise<void>,
  context: AdapterOperationContext,
  operation: string,
): Promise<void> {
  try {
    await request;
  } catch (cause) {
    throw await remoteError(cause, context, operation);
  }
}

async function remoteError(
  cause: unknown,
  context: AdapterOperationContext,
  operation: string,
): Promise<ActivityPlugError> {
  if (cause instanceof TimeoutError) {
    return new ActivityPlugError("TIMEOUT", "Remote Hollo request timed out.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  if (cause instanceof HTTPError) {
    return new ActivityPlugError(
      errorCodeForStatus(cause.response.status),
      `Remote Hollo request failed with HTTP ${cause.response.status}.`,
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
        raw: {
          status: cause.response.status,
          body: await safeResponseText(cause.response),
        },
      },
    );
  }
  return new ActivityPlugError("NETWORK_ERROR", "Remote Hollo request failed.", {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
  });
}

function errorCodeForStatus(
  status: number,
): "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "REMOTE_ERROR" {
  if (status === 401 || status === 403) return "AUTH_REQUIRED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return "REMOTE_ERROR";
}

async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
