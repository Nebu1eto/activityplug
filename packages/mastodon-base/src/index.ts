import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  mergeCapabilityLayers,
  type Account,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type AuthSession,
  type CreatePostInput,
  type DeletePostInput,
  type DeletedEntity,
  type Connection,
  type InstanceProfile,
  type MediaAttachment,
  type MuteAccountInput,
  type PageInput,
  type Poll,
  type Post,
  type PublicTimelineInput,
  type Relationship,
  type RelationshipInput,
  type SearchInput,
  type SearchResult,
  type UploadMediaInput,
  type VotePollInput,
} from "@activityplug/core";
import ky, { type KyInstance } from "ky";

import {
  absoluteRemoteUrl,
  accountFromResponse,
  assertRecordResponse,
  boostPost,
  clientFor,
  createAuthorizationUrl,
  decodeAccountPostsCursor,
  errorContext,
  exchangeAuthorizationCode,
  hashtagFromResponse,
  invalidRemoteResponse,
  isRecord,
  mastodonPageInfo,
  mastodonPageInfoForOperation,
  mastodonPageSearchParams,
  mastodonVisibilityInput,
  mediaAttachmentFromResponse,
  normalizeHandle,
  optionalArray,
  optionalBoolean,
  optionalNonEmptyString,
  optionalObject,
  optionalString,
  optionalStringArray,
  parseJsonArray,
  pollFromResponse,
  postAction,
  postFromResponse,
  refreshToken,
  registerOAuthClient,
  relationshipFromResponse,
  requestJson,
  requestResponse,
  revokeToken,
  tokenHeader,
  verifyCredentials,
} from "./internals.js";
import {
  type MastodonAccountResponse,
  type MastodonBaseAdapterOptions,
  type MastodonInstanceResponse,
  type MastodonMediaAttachmentResponse,
  type MastodonPollResponse,
  type MastodonRelationshipResponse,
  type MastodonSearchResponse,
  type MastodonStatusResponse,
  type NodeInfoLinksResponse,
  type NodeInfoResponse,
} from "./types.js";

export { clientFor, requestVoid, tokenHeader, type MastodonTransportOptions } from "./internals.js";

export { accountFromResponse, postFromResponse } from "./internals.js";
export type * from "./types.js";

export function createMastodonBaseAdapter(
  options: MastodonBaseAdapterOptions,
): ActivityPlugAdapter {
  return {
    metadata: {
      id: options.id,
      displayName: options.displayName,
      kind: options.kind ?? "mastodon-compatible",
      supportedSoftware: options.supportedSoftware,
      staticCapabilities: createCapabilitySet({
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability(
          options.supportsRefreshToken === true ? "supported" : "unsupported",
          options.supportsRefreshToken === true
            ? undefined
            : "This adapter does not assume refresh-token support.",
        ),
        "auth.tokenInjection": capability("supported"),
        "instance.nodeInfo": capability("supported"),
        "accounts.relationships": capability("supported"),
        "accounts.lookupById": capability("supported"),
        "accounts.lookupByHandle": capability("supported"),
        "posts.read": capability("supported"),
        "posts.create": capability("supported"),
        "posts.delete": capability("supported"),
        "posts.reply": capability("supported"),
        "posts.quote": capability(
          "unsupported",
          "This adapter does not expose a stable quote-post API.",
        ),
        "timelines.home": capability("supported"),
        "timelines.public": capability("supported"),
        "timelines.local": capability("supported"),
        "timelines.hashtag": capability("supported"),
        "media.upload": capability("supported"),
        "polls.create": capability("supported"),
        "polls.read": capability("supported"),
        "polls.vote": capability("supported"),
        "search.accounts": capability("supported"),
        "search.posts": capability("supported"),
        "search.hashtags": capability("supported"),
        "social.follow": capability("supported"),
        "social.block": capability("supported"),
        "social.mute": capability("supported"),
        "social.favourite": capability("supported"),
        "social.bookmark": capability("supported"),
        "social.boost": capability("supported"),
        "social.reaction": capability(
          "unsupported",
          "Mastodon-compatible base APIs do not assume emoji reaction support.",
        ),
      }),
      ...(options.documentationUrl === undefined
        ? {}
        : { documentationUrl: options.documentationUrl }),
    },
    instances: {
      detect: async (_input, context) => getInstanceProfile(context, options),
      getProfile: async (_input, context) => getInstanceProfile(context, options),
    },
    accounts: {
      getById: async (input, context) => getAccountById(input.id, context, options),
      getByHandle: async (input, context) => getAccountByHandle(input.handle, context, options),
      listPosts: async (input, context) =>
        listAccountPosts(input.accountId, input.page, context, options, input.session),
    },
    posts: {
      get: async (input, context) => getPost(input.id, context, options),
      create: async (input, context) => createPost(input, context, options),
      delete: async (input, context) => deletePost(input, context, options),
    },
    timelines: {
      home: async (input, context) => listHomeTimeline(input.session, input.page, context, options),
      public: async (input, context) => listPublicTimeline(input, context, options),
      hashtag: async (input, context) =>
        listHashtagTimeline(input.tag, input.page, context, options),
    },
    search: {
      search: async (input, context) => search(input, context, options),
    },
    media: {
      upload: async (input, context) => uploadMedia(input, context, options),
    },
    polls: {
      get: async (input, context) => getPoll(input, context, options),
      vote: async (input, context) => votePoll(input, context, options),
    },
    social: {
      relationship: async (input, context) => relationship(input, context, options),
      follow: async (input, context) =>
        accountRelationshipAction(input, "follow", context, options),
      unfollow: async (input, context) =>
        accountRelationshipAction(input, "unfollow", context, options),
      block: async (input, context) => accountRelationshipAction(input, "block", context, options),
      unblock: async (input, context) =>
        accountRelationshipAction(input, "unblock", context, options),
      mute: async (input, context) => muteAccount(input, context, options),
      unmute: async (input, context) =>
        accountRelationshipAction(input, "unmute", context, options),
      favourite: async (input, context) => postAction(input, "favourite", context, options),
      unfavourite: async (input, context) => postAction(input, "unfavourite", context, options),
      bookmark: async (input, context) => postAction(input, "bookmark", context, options),
      unbookmark: async (input, context) => postAction(input, "unbookmark", context, options),
      boost: async (input, context) => boostPost(input, context, options),
      unboost: async (input, context) =>
        postAction(input, "unreblog", context, options, "social.unboost"),
    },
    auth: {
      registerOAuthClient: async (input, context) => registerOAuthClient(input, context, options),
      createAuthorizationUrl: async (input, context) => createAuthorizationUrl(input, context),
      exchangeAuthorizationCode: async (input, context) =>
        exchangeAuthorizationCode(input, context, options),
      refreshToken: async (input, context) => {
        if (options.supportsRefreshToken !== true) {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "This adapter does not support OAuth refresh tokens.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "auth.oauth.refresh",
              capability: "auth.oauth.refreshToken",
            },
          );
        }
        return refreshToken(input.session, context, options);
      },
      revokeToken: async (input, context) => revokeToken(input, context, options),
      verifyCredentials: async (input, context) =>
        verifyCredentials(input.session, context, options),
    },
  };
}

async function getInstanceProfile(
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<InstanceProfile> {
  const client = clientFor(context, options);
  const [nodeInfo, instance] = await Promise.all([
    getNodeInfo(client, context, options),
    getInstanceDocument(client, context, options),
  ]);
  const software = optionalObject(
    nodeInfo?.software,
    "software",
    nodeInfo,
    context,
    "instance.nodeInfo",
  );
  const registrations = optionalObject(
    instance.registrations,
    "registrations",
    instance,
    context,
    "instance.get",
  );
  const softwareName =
    optionalNonEmptyString(
      software?.name,
      "software.name",
      nodeInfo,
      context,
      "instance.nodeInfo",
    ) ??
    options.supportedSoftware[0] ??
    options.id;
  const softwareVersion =
    optionalString(instance.version, "version", instance, context, "instance.get") ??
    optionalString(software?.version, "software.version", nodeInfo, context, "instance.nodeInfo");
  const domain =
    optionalNonEmptyString(instance.domain, "domain", instance, context, "instance.get") ??
    optionalNonEmptyString(instance.uri, "uri", instance, context, "instance.get") ??
    new URL(context.origin).host;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "instance",
      id: domain,
      rawUrl: context.origin,
    }),
    software: {
      name: softwareName,
      ...(softwareVersion === undefined ? {} : { version: softwareVersion }),
      ...(optionalString(
        software?.repository,
        "software.repository",
        nodeInfo,
        context,
        "instance.nodeInfo",
      ) === undefined
        ? {}
        : {
            repository: optionalString(
              software?.repository,
              "software.repository",
              nodeInfo,
              context,
              "instance.nodeInfo",
            ),
          }),
      ...(optionalString(
        software?.homepage,
        "software.homepage",
        nodeInfo,
        context,
        "instance.nodeInfo",
      ) === undefined
        ? {}
        : {
            homepage: optionalString(
              software?.homepage,
              "software.homepage",
              nodeInfo,
              context,
              "instance.nodeInfo",
            ),
          }),
    },
    ...(optionalString(instance.title, "title", instance, context, "instance.get") === undefined
      ? {}
      : { title: optionalString(instance.title, "title", instance, context, "instance.get") }),
    ...(optionalString(instance.description, "description", instance, context, "instance.get") ===
    undefined
      ? {}
      : {
          description: optionalString(
            instance.description,
            "description",
            instance,
            context,
            "instance.get",
          ),
        }),
    languages:
      optionalStringArray(instance.languages, "languages", instance, context, "instance.get") ?? [],
    ...(registrations === undefined
      ? {}
      : {
          registrations: {
            enabled:
              optionalBoolean(
                registrations.enabled,
                "registrations.enabled",
                instance,
                context,
                "instance.get",
              ) ?? false,
            ...(optionalBoolean(
              registrations.approval_required,
              "registrations.approval_required",
              instance,
              context,
              "instance.get",
            ) === undefined
              ? {}
              : {
                  approvalRequired: optionalBoolean(
                    registrations.approval_required,
                    "registrations.approval_required",
                    instance,
                    context,
                    "instance.get",
                  ),
                }),
            ...(optionalBoolean(
              registrations.invite_required,
              "registrations.invite_required",
              instance,
              context,
              "instance.get",
            ) === undefined
              ? {}
              : {
                  inviteRequired: optionalBoolean(
                    registrations.invite_required,
                    "registrations.invite_required",
                    instance,
                    context,
                    "instance.get",
                  ),
                }),
          },
        }),
    capabilities: mergeCapabilityLayers([
      { source: "static", capabilities: context.capabilities },
      {
        source: "instance",
        capabilities: {
          "streaming.timeline": capability(
            isRecord((instance as { readonly urls?: unknown }).urls) &&
              typeof (instance as { readonly urls?: Record<string, unknown> }).urls?.[
                "streaming_api"
              ] === "string"
              ? "supported"
              : "unknown",
          ),
        },
      },
    ]),
    raw: { nodeInfo, instance },
  };
}

async function getInstanceDocument(
  client: KyInstance,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<MastodonInstanceResponse> {
  try {
    const response = await requestJson<MastodonInstanceResponse>(
      client.get("api/v2/instance").json(),
      "instance.get",
      context,
    );
    assertRecordResponse(
      response,
      "Mastodon instance response is missing required fields.",
      context,
      "instance.get",
    );
    return response;
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "NOT_FOUND") {
      try {
        const response = await requestJson<MastodonInstanceResponse>(
          client.get("api/v1/instance").json(),
          "instance.get",
          context,
        );
        assertRecordResponse(
          response,
          "Mastodon instance response is missing required fields.",
          context,
          "instance.get",
        );
        return response;
      } catch (fallbackError) {
        if (
          options.instanceEndpointRequired === false &&
          fallbackError instanceof ActivityPlugError &&
          fallbackError.code === "NOT_FOUND"
        ) {
          return {};
        }
        throw fallbackError;
      }
    }
    throw error;
  }
}

async function getNodeInfo(
  client: KyInstance,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<NodeInfoResponse | undefined> {
  try {
    const links = await requestJson<NodeInfoLinksResponse>(
      client.get(".well-known/nodeinfo").json(),
      "instance.nodeInfo",
      context,
    );
    assertRecordResponse(
      links,
      "Mastodon NodeInfo links response is malformed.",
      context,
      "instance.nodeInfo",
    );
    const linkEntries = optionalArray(links.links, "links", links, context, "instance.nodeInfo");
    const href = linkEntries
      ?.map((link) => {
        if (!isRecord(link)) {
          throw invalidRemoteResponse("Mastodon NodeInfo link response is malformed.", {
            context,
            operation: "instance.nodeInfo",
            raw: link,
          });
        }
        return {
          href: optionalString(link.href, "links.href", link, context, "instance.nodeInfo"),
          rel: optionalString(link.rel, "links.rel", link, context, "instance.nodeInfo"),
        };
      })
      .filter((link) => link.href !== undefined)
      .toSorted(
        (left, right) => nodeInfoRelPriority(right.rel) - nodeInfoRelPriority(left.rel),
      )[0]?.href;
    if (href === undefined) return undefined;
    const nodeInfoUrl = absoluteRemoteUrl(href, context, "instance.nodeInfo");
    const nodeInfo = await requestJson<NodeInfoResponse>(
      ky.get(nodeInfoUrl, { fetch: options.fetch, redirect: "manual" }).json(),
      "instance.nodeInfo",
      context,
    );
    assertRecordResponse(
      nodeInfo,
      "Mastodon NodeInfo response is malformed.",
      context,
      "instance.nodeInfo",
    );
    return nodeInfo;
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
}

function nodeInfoRelPriority(rel: string | undefined): number {
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/2.1") return 3;
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/2.0") return 2;
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/1.0") return 1;
  return 0;
}

async function getAccountById(
  id: string,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Account> {
  const response = await requestJson<MastodonAccountResponse>(
    clientFor(context, options)
      .get(`api/v1/accounts/${encodeURIComponent(id)}`)
      .json(),
    "account.get",
    context,
  );
  return accountFromResponse(response, context, "account.get");
}

async function getAccountByHandle(
  handle: string,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Account | null> {
  try {
    const response = await requestJson<MastodonAccountResponse>(
      clientFor(context, options)
        .get("api/v1/accounts/lookup", { searchParams: { acct: normalizeHandle(handle, context) } })
        .json(),
      "account.lookup",
      context,
    );
    return accountFromResponse(response, context, "account.lookup");
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

async function listAccountPosts(
  accountId: string,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  session?: AuthSession,
): Promise<Connection<Post>> {
  const searchParams = new URLSearchParams();
  if (page?.limit !== undefined) searchParams.set("limit", String(page.limit));
  if (page?.after !== undefined)
    searchParams.set("max_id", decodeAccountPostsCursor(page.after, context));
  if (page?.before !== undefined)
    searchParams.set("min_id", decodeAccountPostsCursor(page.before, context));
  const remoteResponse = await requestResponse(
    clientFor(context, options).get(`api/v1/accounts/${encodeURIComponent(accountId)}/statuses`, {
      searchParams,
      ...(session === undefined
        ? {}
        : { headers: await tokenHeader(session, context, "account.posts") }),
    }),
    "account.posts",
    context,
  );
  const response = await parseJsonArray<MastodonStatusResponse>(
    remoteResponse,
    "account.posts",
    context,
  );
  return {
    nodes: response.map((status) => postFromResponse(status, context)),
    pageInfo: mastodonPageInfo(response, remoteResponse.headers, context),
  };
}

async function getPost(
  id: string,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Post> {
  const response = await requestJson<MastodonStatusResponse>(
    clientFor(context, options)
      .get(`api/v1/statuses/${encodeURIComponent(id)}`)
      .json(),
    "post.get",
    context,
  );
  return postFromResponse(response, context);
}

async function listHomeTimeline(
  session: AuthSession,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Post>> {
  return listTimeline(
    "api/v1/timelines/home",
    page,
    context,
    options,
    "timeline.home",
    await tokenHeader(session, context, "timeline.home"),
  );
}

async function listPublicTimeline(
  input: PublicTimelineInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Post>> {
  const operation = input.local === true ? "timeline.local" : "timeline.public";
  return listTimeline(
    "api/v1/timelines/public",
    input.page,
    context,
    options,
    operation,
    input.session === undefined ? undefined : await tokenHeader(input.session, context, operation),
    input.local === true ? { local: "true" } : undefined,
  );
}

async function listHashtagTimeline(
  tag: string,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Post>> {
  if (tag.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Hashtag must not be empty.", {
      ...errorContext(context, "timeline.hashtag"),
    });
  }
  return listTimeline(
    `api/v1/timelines/tag/${encodeURIComponent(tag)}`,
    page,
    context,
    options,
    "timeline.hashtag",
  );
}

async function listTimeline(
  path: string,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  operation: string,
  headers?: Record<string, string>,
  extraSearchParams?: Record<string, string>,
): Promise<Connection<Post>> {
  const searchParams = mastodonPageSearchParams(page, context, operation);
  for (const [name, value] of Object.entries(extraSearchParams ?? {}))
    searchParams.set(name, value);
  const remoteResponse = await requestResponse(
    clientFor(context, options).get(path, {
      searchParams,
      ...(headers === undefined ? {} : { headers }),
    }),
    operation,
    context,
  );
  const response = await parseJsonArray<MastodonStatusResponse>(remoteResponse, operation, context);
  return {
    nodes: response.map((status) => postFromResponse(status, context)),
    pageInfo: mastodonPageInfoForOperation(response, remoteResponse.headers, context, operation),
  };
}

async function search(
  input: SearchInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<SearchResult> {
  const searchParams = new URLSearchParams({
    q: input.query,
    ...(input.resolve === undefined ? {} : { resolve: String(input.resolve) }),
  });
  if (input.type === "accounts") searchParams.set("type", "accounts");
  if (input.type === "posts") searchParams.set("type", "statuses");
  if (input.type === "hashtags") searchParams.set("type", "hashtags");
  if (input.page?.limit !== undefined) searchParams.set("limit", String(input.page.limit));
  const headers =
    input.session === undefined ? undefined : await tokenHeader(input.session, context, "search");
  const response = await requestJson<MastodonSearchResponse>(
    clientFor(context, options)
      .get("api/v2/search", {
        searchParams,
        ...(headers === undefined ? {} : { headers }),
      })
      .json(),
    "search",
    context,
  );
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon search response is malformed.", {
      context,
      operation: "search",
      raw: response,
    });
  }
  return {
    accounts: (optionalArray(response.accounts, "accounts", response, context, "search") ?? []).map(
      (account) => accountFromResponse(account as MastodonAccountResponse, context, "search"),
    ),
    posts: (optionalArray(response.statuses, "statuses", response, context, "search") ?? []).map(
      (status) => postFromResponse(status as MastodonStatusResponse, context),
    ),
    hashtags: (optionalArray(response.hashtags, "hashtags", response, context, "search") ?? []).map(
      (hashtag) => hashtagFromResponse(hashtag, context),
    ),
    raw: response,
  };
}

async function uploadMedia(
  input: UploadMediaInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<MediaAttachment> {
  if (input.sensitive === true) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Mastodon-compatible media uploads do not support media-level sensitivity.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "media.upload",
        capability: "media.upload",
      },
    );
  }
  const form = new FormData();
  form.set("file", input.file, input.filename);
  if (input.description !== undefined) form.set("description", input.description);
  const response = await requestJson<MastodonMediaAttachmentResponse>(
    clientFor(context, options)
      .post("api/v2/media", {
        headers: await tokenHeader(input.session, context, "media.upload"),
        body: form,
      })
      .json(),
    "media.upload",
    context,
  );
  return mediaAttachmentFromResponse(response, context, "media.upload");
}

async function createPost(
  input: CreatePostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Post> {
  if (input.poll !== undefined && input.mediaIds !== undefined && input.mediaIds.length > 0) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Mastodon-compatible status creation cannot combine media attachments and polls.",
      { ...errorContext(context, "post.create"), capability: "posts.create" },
    );
  }
  if (input.quoteOfId !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "This adapter cannot create quote posts without silently changing the request.",
      { ...errorContext(context, "post.create"), capability: "posts.quote" },
    );
  }
  const json = {
    status: input.content,
    ...(input.visibility === undefined
      ? {}
      : {
          visibility: mastodonVisibilityInput(input.visibility, context, options, "post.create"),
        }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
    ...(input.summary === undefined ? {} : { spoiler_text: input.summary }),
    ...(input.replyToId === undefined ? {} : { in_reply_to_id: input.replyToId }),
    ...(input.mediaIds === undefined ? {} : { media_ids: input.mediaIds }),
    ...(input.poll === undefined
      ? {}
      : {
          poll: {
            options: input.poll.options,
            multiple: input.poll.multiple ?? false,
            ...(input.poll.expiresInSeconds === undefined
              ? {}
              : { expires_in: input.poll.expiresInSeconds }),
          },
        }),
  };
  const response = await requestJson<MastodonStatusResponse>(
    clientFor(context, options)
      .post("api/v1/statuses", {
        headers: await tokenHeader(input.session, context, "post.create"),
        json,
      })
      .json(),
    "post.create",
    context,
  );
  return postFromResponse(response, context);
}

async function deletePost(
  input: DeletePostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<DeletedEntity> {
  const response = await requestJson<unknown>(
    clientFor(context, options)
      .delete(`api/v1/statuses/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "post.delete"),
      })
      .json(),
    "post.delete",
    context,
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: input.id,
    }),
    deleted: true,
    raw: response,
  };
}

async function getPoll(
  input: { readonly id: string; readonly session?: AuthSession },
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Poll> {
  const response = await requestJson<MastodonPollResponse>(
    clientFor(context, options)
      .get(`api/v1/polls/${encodeURIComponent(input.id)}`, {
        headers:
          input.session === undefined ? {} : await tokenHeader(input.session, context, "poll.get"),
      })
      .json(),
    "poll.get",
    context,
  );
  const poll = pollFromResponse(response, input.id, context).poll;
  if (poll === undefined) {
    throw invalidRemoteResponse("Mastodon poll response is missing required fields.", {
      context,
      operation: "poll.get",
      raw: response,
    });
  }
  return poll;
}

async function votePoll(
  input: VotePollInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Poll> {
  const response = await requestJson<MastodonPollResponse>(
    clientFor(context, options)
      .post(`api/v1/polls/${encodeURIComponent(input.pollId)}/votes`, {
        headers: await tokenHeader(input.session, context, "poll.vote"),
        json: { choices: input.choices },
      })
      .json(),
    "poll.vote",
    context,
  );
  const poll = pollFromResponse(response, input.pollId, context).poll;
  if (poll === undefined) {
    throw invalidRemoteResponse("Mastodon poll response is missing required fields.", {
      context,
      operation: "poll.vote",
      raw: response,
    });
  }
  return poll;
}

async function relationship(
  input: RelationshipInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Relationship> {
  const response = await requestJson<readonly MastodonRelationshipResponse[]>(
    clientFor(context, options)
      .get("api/v1/accounts/relationships", {
        headers: await tokenHeader(input.session, context, "account.relationships"),
        searchParams: { id: input.accountId },
      })
      .json(),
    "account.relationships",
    context,
  );
  if (!Array.isArray(response) || response[0] === undefined) {
    throw invalidRemoteResponse("Mastodon relationship response is malformed.", {
      context,
      operation: "account.relationships",
      raw: response,
    });
  }
  return relationshipFromResponse(response[0], context);
}

async function accountRelationshipAction(
  input: RelationshipInput,
  action: "follow" | "unfollow" | "block" | "unblock" | "unmute",
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Relationship> {
  const response = await requestJson<MastodonRelationshipResponse>(
    clientFor(context, options)
      .post(`api/v1/accounts/${encodeURIComponent(input.accountId)}/${action}`, {
        headers: await tokenHeader(input.session, context, `social.${action}`),
      })
      .json(),
    `social.${action}`,
    context,
  );
  return relationshipFromResponse(response, context);
}

async function muteAccount(
  input: MuteAccountInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Relationship> {
  const response = await requestJson<MastodonRelationshipResponse>(
    clientFor(context, options)
      .post(`api/v1/accounts/${encodeURIComponent(input.accountId)}/mute`, {
        headers: await tokenHeader(input.session, context, "social.mute"),
        json: {
          ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
          ...(input.durationSeconds === undefined ? {} : { duration: input.durationSeconds }),
        },
      })
      .json(),
    "social.mute",
    context,
  );
  return relationshipFromResponse(response, context);
}
