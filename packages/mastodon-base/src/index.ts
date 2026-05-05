import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  type Account,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type AuthSession,
  type CreatePostInput,
  type DeleteMediaInput,
  type DeletePostInput,
  type DeletedEntity,
  type Connection,
  type InstanceProfile,
  type ListTimelineInput,
  type MediaAttachment,
  type MuteAccountInput,
  type PageInput,
  type Poll,
  type Post,
  type PostHistoryInput,
  type PostRevision,
  type PublicTimelineInput,
  type Relationship,
  type RelationshipInput,
  type SearchInput,
  type SearchResult,
  type UpdateMediaInput,
  type UpdatePostInput,
  type UpdateProfileInput,
  type UploadMediaInput,
  type UploadMediaFromUrlInput,
  type VotePollInput,
} from "@activityplug/core";
import ky, { type KyInstance } from "ky";

import { createFilter, deleteFilter, getFilter, listFilters } from "./filters.js";
import { followRequestAction, listFollowRequests } from "./follow-requests.js";
import {
  absoluteRemoteUrl,
  accountFromResponse,
  assertRecordResponse,
  boostPost,
  clientFor,
  createAuthorizationUrl,
  decodeAccountPostsCursor,
  decodeOperationCursor,
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
  optionalDateTimeString,
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
  requestVoid,
  revokeToken,
  tokenHeader,
  verifyCredentials,
} from "./internals.js";
import {
  addListAccount,
  createList,
  deleteList,
  getList,
  listListAccounts,
  listLists,
  removeListAccount,
  updateList,
} from "./lists.js";
import {
  clearNotifications,
  dismissNotification,
  listNotifications,
  notificationUnreadCount,
} from "./notifications.js";
import {
  deleteScheduledPost,
  getScheduledPost,
  listScheduledPosts,
  schedulePost,
  updateScheduledPost,
} from "./scheduled-posts.js";
import {
  type MastodonAccountResponse,
  type MastodonBaseAdapterOptions,
  type MastodonInstanceResponse,
  type MastodonMediaAttachmentResponse,
  type MastodonPollResponse,
  type MastodonRelationshipResponse,
  type MastodonSearchResponse,
  type MastodonStatusEditResponse,
  type MastodonStatusResponse,
  type NodeInfoLinksResponse,
  type NodeInfoResponse,
} from "./types.js";

export {
  clientFor,
  parseJsonArray,
  requestJson,
  requestResponse,
  requestVoid,
  tokenHeader,
  type MastodonTransportOptions,
} from "./internals.js";

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
        "auth.oauth.clientCredentials": capability(
          "unsupported",
          "Client-credentials OAuth is not mapped by this adapter.",
        ),
        "auth.passkey": capability("unsupported", "Passkey auth is not mapped by this adapter."),
        "auth.tokenInjection": capability("supported"),
        "instance.nodeInfo": capability("supported"),
        "instance.peers": capability("unsupported", "Peer listing is not mapped by this adapter."),
        "accounts.relationships": capability("supported"),
        "accounts.lookupById": capability("supported"),
        "accounts.lookupByHandle": capability("supported"),
        "accounts.updateProfile": capability("supported"),
        "accounts.followers": capability("supported"),
        "accounts.following": capability("supported"),
        "posts.read": capability("supported"),
        "posts.create": capability("supported"),
        "posts.delete": capability("supported"),
        "posts.update": capability("supported"),
        "posts.reply": capability("supported"),
        "posts.quote": capability(
          options.quoteStatusParameter === undefined ? "unsupported" : "supported",
          options.quoteStatusParameter === undefined
            ? "This adapter does not expose a stable quote-post API."
            : undefined,
        ),
        "posts.translate": capability(
          "unsupported",
          "Post translation is not mapped by this adapter.",
        ),
        "posts.history": capability("supported"),
        "timelines.home": capability("supported"),
        "timelines.public": capability("supported"),
        "timelines.local": capability("supported"),
        "timelines.hashtag": capability("supported"),
        "timelines.list": capability("supported"),
        "media.upload": capability("supported"),
        "media.update": capability("supported"),
        "media.delete": capability("supported"),
        "media.remoteUrlUpload": capability(
          "unsupported",
          "Remote URL media upload is not mapped by this adapter.",
        ),
        "media.urlIngestion": capability(
          "unsupported",
          "URL media ingestion is not mapped by this adapter.",
        ),
        "notifications.list": capability("supported"),
        "notifications.grouped": capability(
          "unsupported",
          "Grouped notifications are not mapped by this adapter.",
        ),
        "notifications.pleromaEmojiReaction": capability(
          "unsupported",
          "Pleroma-specific notification types are not mapped by this base adapter.",
        ),
        "notifications.pleromaChatMention": capability(
          "unsupported",
          "Pleroma-specific notification types are not mapped by this base adapter.",
        ),
        "notifications.pleromaReport": capability(
          "unsupported",
          "Pleroma-specific notification types are not mapped by this base adapter.",
        ),
        "notifications.dismiss": capability("supported"),
        "notifications.clear": capability("supported"),
        "notifications.unreadCount": capability("supported"),
        "polls.create": capability("supported"),
        "polls.read": capability("supported"),
        "polls.vote": capability("supported"),
        "lists.read": capability("supported"),
        "lists.create": capability("supported"),
        "lists.update": capability("supported"),
        "lists.delete": capability("supported"),
        "lists.members": capability("supported"),
        "followRequests.list": capability("supported"),
        "followRequests.accept": capability("supported"),
        "followRequests.reject": capability("supported"),
        "filters.read": capability("supported"),
        "filters.create": capability("supported"),
        "filters.update": capability(
          "unsupported",
          "Mastodon v2 filter keyword replacement is not mapped by this adapter yet.",
        ),
        "filters.delete": capability("supported"),
        "scheduledPosts.read": capability("supported"),
        "scheduledPosts.create": capability("supported"),
        "scheduledPosts.update": capability("supported"),
        "scheduledPosts.delete": capability("supported"),
        "search.accounts": capability("supported"),
        "search.posts": capability("supported"),
        "search.hashtags": capability("supported"),
        "social.follow": capability("supported"),
        "social.block": capability("supported"),
        "social.mute": capability("supported"),
        "social.favourite": capability("supported"),
        "social.bookmark": capability("supported"),
        "social.bookmarkFolders": capability(
          "unsupported",
          "Bookmark folders are not mapped by this adapter.",
        ),
        "social.boost": capability("supported"),
        "social.reaction": capability(
          "unsupported",
          "Mastodon-compatible base APIs do not assume emoji reaction support.",
        ),
        "streaming.timeline": capability(
          "unsupported",
          "Streaming is not implemented by this adapter yet.",
        ),
        "streaming.notifications": capability(
          "unsupported",
          "Streaming is not implemented by this adapter yet.",
        ),
        "streaming.conversations": capability(
          "unsupported",
          "Streaming is not implemented by this adapter yet.",
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
      updateProfile: async (input, context) => updateProfile(input, context, options),
      listFollowers: async (input, context) =>
        listAccountFollows(
          input.accountId,
          "followers",
          input.page,
          context,
          options,
          input.session,
        ),
      listFollowing: async (input, context) =>
        listAccountFollows(
          input.accountId,
          "following",
          input.page,
          context,
          options,
          input.session,
        ),
      listPosts: async (input, context) =>
        listAccountPosts(input.accountId, input.page, context, options, input.session),
    },
    posts: {
      get: async (input, context) => getPost(input.id, context, options),
      create: async (input, context) => createPost(input, context, options),
      update: async (input, context) => updatePost(input, context, options),
      history: async (input, context) => postHistory(input, context, options),
      delete: async (input, context) => deletePost(input, context, options),
    },
    timelines: {
      home: async (input, context) => listHomeTimeline(input.session, input.page, context, options),
      public: async (input, context) => listPublicTimeline(input, context, options),
      hashtag: async (input, context) =>
        listHashtagTimeline(input.tag, input.page, context, options),
      list: async (input, context) => listTimeline(input, context, options),
    },
    search: {
      search: async (input, context) => search(input, context, options),
    },
    media: {
      upload: async (input, context) => uploadMedia(input, context, options),
      update: async (input, context) => updateMedia(input, context, options),
      delete: async (input, context) => deleteMedia(input, context, options),
      uploadFromUrl: async (input, context) => uploadMediaFromUrl(input, context, options),
    },
    polls: {
      get: async (input, context) => getPoll(input, context, options),
      vote: async (input, context) => votePoll(input, context, options),
    },
    notifications: {
      list: async (input, context) => listNotifications(input, context, options),
      unreadCount: async (input, context) => notificationUnreadCount(input, context, options),
      dismiss: async (input, context) => dismissNotification(input, context, options),
      clear: async (input, context) => clearNotifications(input, context, options),
    },
    lists: {
      list: async (input, context) => listLists(input, context, options),
      get: async (input, context) => getList(input, context, options),
      create: async (input, context) => createList(input, context, options),
      update: async (input, context) => updateList(input, context, options),
      delete: async (input, context) => deleteList(input, context, options),
      listAccounts: async (input, context) => listListAccounts(input, context, options),
      addAccount: async (input, context) => addListAccount(input, context, options),
      removeAccount: async (input, context) => removeListAccount(input, context, options),
    },
    followRequests: {
      list: async (input, context) => listFollowRequests(input, context, options),
      accept: async (input, context) => followRequestAction(input, "authorize", context, options),
      reject: async (input, context) => followRequestAction(input, "reject", context, options),
    },
    filters: {
      list: async (input, context) => listFilters(input, context, options),
      get: async (input, context) => getFilter(input, context, options),
      create: async (input, context) => createFilter(input, context, options),
      update: async (_input, context) => {
        throw new ActivityPlugError(
          "UNSUPPORTED_OPERATION",
          "Mastodon v2 filter keyword replacement is not mapped by this adapter yet.",
          {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "filter.update",
            capability: "filters.update",
          },
        );
      },
      delete: async (input, context) => deleteFilter(input, context, options),
    },
    scheduledPosts: {
      list: async (input, context) => listScheduledPosts(input, context, options),
      get: async (input, context) => getScheduledPost(input, context, options),
      create: async (input, context) => schedulePost(input, context, options),
      update: async (input, context) => updateScheduledPost(input, context, options),
      delete: async (input, context) => deleteScheduledPost(input, context, options),
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
    capabilities: context.capabilities,
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
    nodes: response.map((status) => postFromResponse(status, context, "account.posts")),
    pageInfo: mastodonPageInfo(response, remoteResponse.headers, context),
  };
}

async function listAccountFollows(
  accountId: string,
  collection: "followers" | "following",
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  session?: AuthSession,
): Promise<Connection<Account>> {
  const operation = collection === "followers" ? "account.followers" : "account.following";
  const searchParams = new URLSearchParams();
  if (page?.limit !== undefined) searchParams.set("limit", String(page.limit));
  if (page?.after !== undefined)
    searchParams.set("max_id", decodeOperationCursor(page.after, context, operation));
  if (page?.before !== undefined)
    searchParams.set("min_id", decodeOperationCursor(page.before, context, operation));
  const remoteResponse = await requestResponse(
    clientFor(context, options).get(
      `api/v1/accounts/${encodeURIComponent(accountId)}/${collection}`,
      {
        searchParams,
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, operation) }),
      },
    ),
    operation,
    context,
  );
  const response = await parseJsonArray<MastodonAccountResponse>(
    remoteResponse,
    operation,
    context,
  );
  return {
    nodes: response.map((account) => accountFromResponse(account, context, operation)),
    pageInfo: mastodonPageInfoForOperation(
      response as readonly MastodonStatusResponse[],
      remoteResponse.headers,
      context,
      operation,
    ),
  };
}

async function updateProfile(
  input: UpdateProfileInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Account> {
  if (input.avatarId !== undefined || input.headerId !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Mastodon-compatible profile images require binary avatar or header uploads.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "account.updateProfile",
        capability: "accounts.updateProfile",
      },
    );
  }
  const form = new FormData();
  if (input.displayName !== undefined) form.set("display_name", input.displayName);
  if (input.note !== undefined) form.set("note", input.note);
  if (input.locked !== undefined) form.set("locked", String(input.locked));
  if (input.bot !== undefined) form.set("bot", String(input.bot));
  for (const [index, field] of (input.fields ?? []).entries()) {
    form.set(`fields_attributes[${index}][name]`, field.name);
    form.set(`fields_attributes[${index}][value]`, field.value);
  }
  const response = await requestJson<MastodonAccountResponse>(
    clientFor(context, options)
      .patch("api/v1/accounts/update_credentials", {
        headers: await tokenHeader(input.session, context, "account.updateProfile"),
        body: form,
      })
      .json(),
    "account.updateProfile",
    context,
  );
  return accountFromResponse(response, context, "account.updateProfile");
}

async function getPost(
  id: string,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  session?: AuthSession,
  operation = "post.get",
): Promise<Post> {
  const response = await requestJson<MastodonStatusResponse>(
    clientFor(context, options)
      .get(
        `api/v1/statuses/${encodeURIComponent(id)}`,
        session === undefined ? {} : { headers: await tokenHeader(session, context, operation) },
      )
      .json(),
    operation,
    context,
  );
  return postFromResponse(response, context, operation);
}

async function listHomeTimeline(
  session: AuthSession,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Post>> {
  return listStatusTimeline(
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
  return listStatusTimeline(
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
  return listStatusTimeline(
    `api/v1/timelines/tag/${encodeURIComponent(tag)}`,
    page,
    context,
    options,
    "timeline.hashtag",
  );
}

async function listStatusTimeline(
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
    nodes: response.map((status) => postFromResponse(status, context, operation)),
    pageInfo: mastodonPageInfoForOperation(response, remoteResponse.headers, context, operation),
  };
}

async function listTimeline(
  input: ListTimelineInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Post>> {
  return listStatusTimeline(
    `api/v1/timelines/list/${encodeURIComponent(input.listId)}`,
    input.page,
    context,
    options,
    "timeline.list",
    await tokenHeader(input.session, context, "timeline.list"),
  );
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
      (status) => postFromResponse(status as MastodonStatusResponse, context, "account.posts"),
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

async function updateMedia(
  input: UpdateMediaInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<MediaAttachment> {
  if (input.sensitive !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Mastodon-compatible media update does not support media-level sensitivity.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "media.update",
        capability: "media.update",
      },
    );
  }
  const form = new FormData();
  if (input.description !== undefined) form.set("description", input.description);
  const response = await requestJson<MastodonMediaAttachmentResponse>(
    clientFor(context, options)
      .put(`api/v1/media/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "media.update"),
        body: form,
      })
      .json(),
    "media.update",
    context,
  );
  return mediaAttachmentFromResponse(response, context, "media.update");
}

async function deleteMedia(
  input: DeleteMediaInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<DeletedEntity> {
  const raw = await requestJson<unknown>(
    clientFor(context, options)
      .delete(`api/v1/media/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "media.delete"),
      })
      .json(),
    "media.delete",
    context,
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "media",
      id: input.id,
    }),
    deleted: true,
    raw,
  };
}

async function uploadMediaFromUrl(
  input: UploadMediaFromUrlInput,
  context: AdapterOperationContext,
  _options: MastodonBaseAdapterOptions,
): Promise<MediaAttachment> {
  throw new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    "Mastodon-compatible APIs do not expose a remote URL media upload endpoint.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "media.uploadFromUrl",
      capability: "media.remoteUrlUpload",
      raw: { url: input.url },
    },
  );
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
  if (input.quoteOfId !== undefined && options.quoteStatusParameter === undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "This adapter cannot create quote posts without silently changing the request.",
      { ...errorContext(context, "post.create"), capability: "posts.quote" },
    );
  }
  const response = await requestJson<MastodonStatusResponse>(
    clientFor(context, options)
      .post("api/v1/statuses", {
        headers: await tokenHeader(input.session, context, "post.create"),
        json: statusJson(input, context, options, "post.create"),
      })
      .json(),
    "post.create",
    context,
  );
  const post = postFromResponse(response, context, "post.create");
  if (input.quoteOfId !== undefined) {
    if (post.quoteOf?.rawId === input.quoteOfId) return post;
    if (post.quoteOf !== undefined) {
      throw new ActivityPlugError(
        "REMOTE_ERROR",
        "The remote server returned a quote relation for a different post.",
        { ...errorContext(context, "post.create"), raw: response },
      );
    }
    const verified = await getPost(post.ref.rawId, context, options, input.session, "post.create");
    if (verified.quoteOf?.rawId === input.quoteOfId) return verified;
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "The remote server accepted a quote request but did not return the requested quote relation.",
      { ...errorContext(context, "post.create"), raw: response },
    );
  }
  return post;
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

async function updatePost(
  input: UpdatePostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Post> {
  if (
    input.replyToId !== undefined ||
    input.quoteOfId !== undefined ||
    input.mediaIds !== undefined ||
    input.poll !== undefined
  ) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Mastodon-compatible post editing does not support this ActivityPlug input.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "post.update",
        capability: "posts.update",
      },
    );
  }
  const response = await requestJson<MastodonStatusResponse>(
    clientFor(context, options)
      .put(`api/v1/statuses/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "post.update"),
        json: statusJson(input, context, options, "post.update"),
      })
      .json(),
    "post.update",
    context,
  );
  return postFromResponse(response, context, "post.update");
}

async function postHistory(
  input: PostHistoryInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<readonly PostRevision[]> {
  const response = await requestJson<readonly MastodonStatusEditResponse[]>(
    clientFor(context, options)
      .get(`api/v1/statuses/${encodeURIComponent(input.id)}/history`, {
        headers:
          input.session === undefined
            ? {}
            : await tokenHeader(input.session, context, "post.history"),
      })
      .json(),
    "post.history",
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Mastodon status edit history response is malformed.", {
      context,
      operation: "post.history",
      raw: response,
    });
  }
  return response.map((revision) => postRevisionFromResponse(revision, input.id, context));
}

function postRevisionFromResponse(
  response: MastodonStatusEditResponse,
  statusId: string,
  context: AdapterOperationContext,
): PostRevision {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon status edit response is malformed.", {
      context,
      operation: "post.history",
      raw: response,
    });
  }
  const revision = response as unknown as MastodonStatusEditResponse;
  const createdAt = optionalDateTimeString(
    revision.created_at,
    "created_at",
    revision,
    context,
    "post.history",
  );
  if (createdAt === undefined) {
    throw invalidRemoteResponse("Mastodon status edit response is missing created_at.", {
      context,
      operation: "post.history",
      raw: revision,
    });
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "postRevision",
      id: `${statusId}:${createdAt}`,
    }),
    ...(optionalString(revision.content, "content", revision, context, "post.history") === undefined
      ? {}
      : {
          contentHtml: optionalString(
            revision.content,
            "content",
            revision,
            context,
            "post.history",
          ),
        }),
    ...(optionalString(revision.spoiler_text, "spoiler_text", revision, context, "post.history") ===
    undefined
      ? {}
      : {
          summary: optionalString(
            revision.spoiler_text,
            "spoiler_text",
            revision,
            context,
            "post.history",
          ),
        }),
    ...(optionalBoolean(revision.sensitive, "sensitive", revision, context, "post.history") ===
    undefined
      ? {}
      : {
          sensitive: optionalBoolean(
            revision.sensitive,
            "sensitive",
            revision,
            context,
            "post.history",
          ),
        }),
    media: (
      optionalArray(
        revision.media_attachments,
        "media_attachments",
        revision,
        context,
        "post.history",
      ) ?? []
    ).map((media) =>
      mediaAttachmentFromResponse(
        media as MastodonMediaAttachmentResponse,
        context,
        "post.history",
      ),
    ),
    ...pollFromResponse(revision.poll, statusId, context, "post.history"),
    createdAt,
    raw: revision,
  };
}

function statusJson(
  input: CreatePostInput | UpdatePostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  operation: string,
) {
  return {
    ...(input.content === undefined ? {} : { status: input.content }),
    ...(input.visibility === undefined
      ? {}
      : {
          visibility: mastodonVisibilityInput(input.visibility, context, options, operation),
        }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
    ...(input.summary === undefined ? {} : { spoiler_text: input.summary }),
    ...(input.replyToId === undefined ? {} : { in_reply_to_id: input.replyToId }),
    ...(input.quoteOfId === undefined || options.quoteStatusParameter === undefined
      ? {}
      : { [options.quoteStatusParameter]: input.quoteOfId }),
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
  const poll = pollFromResponse(response, input.id, context, "poll.get").poll;
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
  const poll = pollFromResponse(response, input.pollId, context, "poll.vote").poll;
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
