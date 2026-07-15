import {
  ActivityPlugError,
  closeWebSocketSafely,
  createEntityRef,
  MAX_PROFILE_FIELDS,
  MAX_STREAMING_QUEUED_BYTES,
  resolveSameOriginDiscoveryUrl,
  resolveWebSocketFactoryResult,
  webSocketFrameByteLength,
  type Account,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type AuthAdapterContext,
  type AuthSession,
  type BoostPostInput,
  type CapabilityName,
  type Connection,
  type CreatePostInput,
  type DeleteMediaInput,
  type DeletedEntity,
  type InstanceProfile,
  type InjectTokenInput,
  type MediaAttachment,
  type MuteAccountInput,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationUrlInput,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type PageInput,
  type Post,
  type PostActionInput,
  type ReactPostInput,
  type Relationship,
  type RelationshipInput,
  type SearchInput,
  type SearchResult,
  type StoredAuthSession,
  type TokenSet,
  type UpdateMediaInput,
  type UpdateProfileInput,
  type UploadMediaInput,
  type UploadMediaFromUrlInput,
} from "@activityplug/core";
import ky, { type KyInstance } from "ky";

import { createMisskeyStaticCapabilities } from "./capabilities.js";
import { followRequestAction, listFollowRequests } from "./follow-requests.js";
import {
  misskeyNodeInfoRelPriority,
  misskeySearchCapability,
  misskeySearchOperation,
} from "./helpers.js";
import {
  accountFromResponse,
  decodeAccountPostsCursor,
  decodeOperationCursor,
  mediaAttachmentFromResponse,
  misskeyPageInfo,
  misskeyPageInfoForOperation,
  misskeyVisibilityInput,
  noteFromResponse,
  relationshipFromResponse,
} from "./internals.js";
import { listNotifications } from "./notifications.js";
import { getPoll, votePoll } from "./polls.js";
import { connectMisskeyNotificationStream, connectMisskeyTimelineStream } from "./streaming.js";
import {
  assertAccessTokenFresh,
  assertRecordResponse,
  authorizationHeader,
  clientFor,
  errorContext,
  invalidRemoteResponse,
  isRecord,
  joinScopes,
  optionalArray,
  optionalBoolean,
  optionalNonEmptyString,
  optionalObject,
  optionalString,
  optionalStringArray,
  parseHandle,
  requestJson,
  requestVoid,
  requireStoredTokenSet,
  slashOrigin,
  tokenHeader,
  tokenRequestBody,
  tokenSetFromResponse,
} from "./transport.js";
import {
  type MisskeyAdapterOptions,
  type MisskeyFileResponse,
  type MisskeyMeResponse,
  type MisskeyMetaResponse,
  type MisskeyNoteResponse,
  type MisskeyRelationshipResponse,
  type MisskeyTokenResponse,
  type NodeInfoLinksResponse,
  type NodeInfoResponse,
} from "./types.js";
import {
  addUserListAccount,
  createUserList,
  deleteUserList,
  getUserList,
  listUserListAccounts,
  listUserLists,
  listUserListTimeline,
  removeUserListAccount,
  updateUserList,
} from "./user-lists.js";

export { accountFromResponse, noteFromResponse } from "./internals.js";
export type * from "./types.js";

export function createMisskeyAdapter(options: MisskeyAdapterOptions = {}): ActivityPlugAdapter {
  const ingestUrl = (input: UploadMediaFromUrlInput, context: AdapterOperationContext) =>
    uploadMediaFromUrl(input, context, options);
  return {
    metadata: {
      id: "misskey",
      displayName: "Misskey",
      kind: "misskey",
      supportedSoftware: ["misskey"],
      staticCapabilities: createMisskeyStaticCapabilities(typeof options.webSocket === "function"),
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
        listUserConnections(
          input.accountId,
          "api/users/followers",
          input.page,
          context,
          options,
          input.session,
          "account.followers",
        ),
      listFollowing: async (input, context) =>
        listUserConnections(
          input.accountId,
          "api/users/following",
          input.page,
          context,
          options,
          input.session,
          "account.following",
        ),
      listPosts: async (input, context) =>
        listAccountPosts(input.accountId, input.page, context, options, input.session),
    },
    posts: {
      get: async (input, context) => getNote(input.id, context, options, input.session),
      create: async (input, context) => createNote(input, context, options),
      delete: async (input, context) => deleteNote(input, context, options),
    },
    timelines: {
      home: async (input, context) =>
        listTimeline(
          "api/notes/timeline",
          input.session,
          input.page,
          context,
          options,
          "timeline.home",
        ),
      public: async (input, context) =>
        listTimeline(
          input.local === true ? "api/notes/local-timeline" : "api/notes/global-timeline",
          undefined,
          input.page,
          context,
          options,
          input.local === true ? "timeline.local" : "timeline.public",
        ),
      hashtag: async (input, context) =>
        listHashtagTimeline(input.tag, input.page, context, options),
      list: async (input, context) => listUserListTimeline(input, context, options),
    },
    search: {
      search: async (input, context) => search(input, context, options),
    },
    media: {
      upload: async (input, context) => uploadMedia(input, context, options),
      update: async (input, context) => updateMedia(input, context, options),
      delete: async (input, context) => deleteMedia(input, context, options),
      ingestUrl,
      uploadFromUrl: ingestUrl,
    },
    polls: {
      get: async (input, context) => getPoll(input.id, input.session, context, options),
      vote: async (input, context) => votePoll(input, context, options),
    },
    notifications: {
      list: async (input, context) => listNotifications(input, context, options),
      clear: async (_input, context) => {
        throw new ActivityPlugError(
          "UNSUPPORTED_OPERATION",
          "Misskey exposes mark-all-as-read, not a portable notification clear operation.",
          {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "notification.clear",
            capability: "notifications.clear",
          },
        );
      },
    },
    lists: {
      list: async (input, context) => listUserLists(input, context, options),
      get: async (input, context) => getUserList(input, context, options),
      create: async (input, context) => createUserList(input, context, options),
      update: async (input, context) => updateUserList(input, context, options),
      delete: async (input, context) => deleteUserList(input, context, options),
      listAccounts: async (input, context) => listUserListAccounts(input, context, options),
      addAccount: async (input, context) => addUserListAccount(input, context, options),
      removeAccount: async (input, context) => removeUserListAccount(input, context, options),
    },
    followRequests: {
      list: async (input, context) => listFollowRequests(input, context, options),
      accept: async (input, context) =>
        followRequestAction(
          input,
          "following/requests/accept",
          "followRequest.accept",
          context,
          options,
        ),
      reject: async (input, context) =>
        followRequestAction(
          input,
          "following/requests/reject",
          "followRequest.reject",
          context,
          options,
        ),
    },
    social: {
      relationship: async (input, context) => relationship(input, context, options),
      follow: async (input, context) =>
        relationshipAction(input, "following/create", "social.follow", context, options),
      unfollow: async (input, context) =>
        relationshipAction(input, "following/delete", "social.unfollow", context, options),
      block: async (input, context) =>
        relationshipAction(input, "blocking/create", "social.block", context, options),
      unblock: async (input, context) =>
        relationshipAction(input, "blocking/delete", "social.unblock", context, options),
      mute: async (input, context) => muteAccount(input, context, options),
      unmute: async (input, context) =>
        relationshipAction(input, "mute/delete", "social.unmute", context, options),
      favourite: async (input, context) =>
        noteAction(input, "notes/favorites/create", "social.favourite", context, options),
      unfavourite: async (input, context) =>
        noteAction(input, "notes/favorites/delete", "social.unfavourite", context, options),
      boost: async (input, context) => boostNote(input, context, options),
      unboost: async (input, context) => unboostNote(input, context, options),
      react: async (input, context) =>
        noteReaction(input, "notes/reactions/create", "social.reaction", context, options),
      unreact: async (input, context) =>
        noteReaction(input, "notes/reactions/delete", "social.unreaction", context, options),
    },
    streams: {
      timeline: (input, context) => connectMisskeyTimelineStream(input, context, options),
      notifications: (input, context) => connectMisskeyNotificationStream(input, context, options),
    },
    auth: {
      strategies: [
        {
          kind: "oauth",
          registerClient: async (input, context) => registerOAuthClient(input, context),
          start: async (input, context) => createAuthorizationUrl(input, context),
          exchange: async (input, context) => exchangeAuthorizationCode(input, context, options),
          verifySession: async (input, context) =>
            verifyCredentials(input.session, context, options),
        },
        {
          kind: "token",
          importToken: async (input) => tokenSetFromInjectedToken(input),
          verifySession: async (input, context) =>
            verifyCredentials(input.session, context, options),
        },
      ],
    },
  };
}

async function getInstanceProfile(
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<InstanceProfile> {
  const client = clientFor(context, options);
  // Validate discovery links before issuing any additional remote request.
  const nodeInfo = await getNodeInfo(client, context, options);
  const meta = await requestJson<MisskeyMetaResponse>(
    client.post("api/meta", { json: { detail: false } }).json(),
    "instance.get",
    context,
  );
  assertRecordResponse(meta, "Misskey meta response is malformed.", context, "instance.get");
  const software = optionalObject(
    nodeInfo?.software,
    "software",
    nodeInfo,
    context,
    "instance.nodeInfo",
  );
  const host = new URL(context.origin).host;
  const softwareVersion =
    optionalString(meta.version, "version", meta, context, "instance.get") ??
    optionalString(software?.version, "software.version", nodeInfo, context, "instance.nodeInfo");
  const title = optionalString(meta.name, "name", meta, context, "instance.get");
  const description = optionalString(
    meta.description,
    "description",
    meta,
    context,
    "instance.get",
  );
  const disableRegistration = optionalBoolean(
    meta.disableRegistration,
    "disableRegistration",
    meta,
    context,
    "instance.get",
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "instance",
      id: host,
      rawUrl: context.origin,
    }),
    software: {
      name:
        optionalNonEmptyString(
          software?.name,
          "software.name",
          nodeInfo,
          context,
          "instance.nodeInfo",
        ) ?? "misskey",
      ...(softwareVersion === undefined ? {} : { version: softwareVersion }),
    },
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    languages: optionalStringArray(meta.langs, "langs", meta, context, "instance.get") ?? [],
    registrations: {
      enabled: disableRegistration === undefined ? false : !disableRegistration,
    },
    capabilities: context.capabilities,
    raw: { nodeInfo, meta },
  };
}

async function getNodeInfo(
  client: KyInstance,
  context: AdapterOperationContext,
  _options: MisskeyAdapterOptions,
): Promise<NodeInfoResponse | undefined> {
  try {
    const links = await requestJson<NodeInfoLinksResponse>(
      client.get(".well-known/nodeinfo").json(),
      "instance.nodeInfo",
      context,
    );
    assertRecordResponse(
      links,
      "Misskey NodeInfo links response is malformed.",
      context,
      "instance.nodeInfo",
    );
    const linkEntries = optionalArray(links.links, "links", links, context, "instance.nodeInfo");
    const href = linkEntries
      ?.map((link) => {
        if (!isRecord(link)) {
          throw invalidRemoteResponse("Misskey NodeInfo link response is malformed.", {
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
        (left, right) =>
          misskeyNodeInfoRelPriority(right.rel) - misskeyNodeInfoRelPriority(left.rel),
      )[0]?.href;
    if (href === undefined) return undefined;
    // Discovery hrefs are untrusted remote input; reject cross-origin links
    // before the schema request can cross the vetted transport boundary.
    const nodeInfoUrl = resolveSameOriginDiscoveryUrl(href, context.origin, "instance.nodeInfo");
    const nodeInfo = await requestJson<NodeInfoResponse>(
      ky.get(nodeInfoUrl, { fetch: context.fetch, redirect: "manual" }).json(),
      "instance.nodeInfo",
      context,
    );
    assertRecordResponse(
      nodeInfo,
      "Misskey NodeInfo response is malformed.",
      context,
      "instance.nodeInfo",
    );
    return nodeInfo;
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
}

async function getAccountById(
  id: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Account> {
  const response = await requestJson<MisskeyMeResponse>(
    clientFor(context, options)
      .post("api/users/show", { json: { userId: id } })
      .json(),
    "account.get",
    context,
  );
  return accountFromResponse(response, context, "account.get");
}

async function getAccountByHandle(
  handle: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Account | null> {
  const parsed = parseHandle(handle, context.origin);
  try {
    const response = await requestJson<MisskeyMeResponse>(
      clientFor(context, options)
        .post("api/users/show", {
          json: {
            username: parsed.username,
            ...(parsed.host === undefined ? {} : { host: parsed.host }),
          },
        })
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
  options: MisskeyAdapterOptions,
  session?: AuthSession,
): Promise<Connection<Post>> {
  const requestedLimit = Math.min(page?.limit ?? 20, 99);
  const fetchLimit = requestedLimit + 1;
  const response = await requestJson<readonly MisskeyNoteResponse[]>(
    clientFor(context, options)
      .post("api/users/notes", {
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, "account.posts") }),
        json: {
          userId: accountId,
          limit: fetchLimit,
          ...(page?.after === undefined
            ? {}
            : { untilId: decodeAccountPostsCursor(page.after, context) }),
          ...(page?.before === undefined
            ? {}
            : { sinceId: decodeAccountPostsCursor(page.before, context) }),
        },
      })
      .json(),
    "account.posts",
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Misskey notes response did not include the expected array.", {
      context,
      operation: "account.posts",
      raw: response,
    });
  }
  const nodes =
    page?.before === undefined
      ? response.slice(0, requestedLimit)
      : response.slice(0, requestedLimit).toReversed();
  return {
    nodes: nodes.map((note) => noteFromResponse(note, context)),
    pageInfo: misskeyPageInfo(nodes, response.length > nodes.length, page, context),
  };
}

async function listUserConnections(
  accountId: string,
  endpoint: "api/users/followers" | "api/users/following",
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  session: AuthSession | undefined,
  operation: "account.followers" | "account.following",
): Promise<Connection<Account>> {
  const requestedLimit = Math.min(page?.limit ?? 20, 99);
  const fetchLimit = requestedLimit + 1;
  const response = await requestJson<readonly MisskeyFollowingResponse[]>(
    clientFor(context, options)
      .post(endpoint, {
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, operation) }),
        json: {
          userId: accountId,
          limit: fetchLimit,
          ...(page?.after === undefined
            ? {}
            : { untilId: decodeOperationCursor(page.after, context, operation) }),
          ...(page?.before === undefined
            ? {}
            : { sinceId: decodeOperationCursor(page.before, context, operation) }),
        },
      })
      .json(),
    operation,
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Misskey following response did not include the expected array.", {
      context,
      operation,
      raw: response,
    });
  }
  const items =
    page?.before === undefined
      ? response.slice(0, requestedLimit)
      : response.slice(0, requestedLimit).toReversed();
  const nodes = items.map((item) => {
    const account = endpoint === "api/users/followers" ? item.follower : item.followee;
    if (account === undefined) {
      throw invalidRemoteResponse("Misskey following response is missing the account object.", {
        context,
        operation,
        raw: item,
      });
    }
    return accountFromResponse(account, context, operation);
  });
  return {
    nodes,
    pageInfo: misskeyPageInfoForOperation(
      items as readonly MisskeyNoteResponse[],
      response.length > nodes.length,
      page,
      context,
      operation,
    ),
  };
}

interface MisskeyFollowingResponse {
  readonly id?: string;
  readonly follower?: MisskeyMeResponse;
  readonly followee?: MisskeyMeResponse;
}

async function getNote(
  id: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  session?: AuthSession,
): Promise<Post> {
  const response = await requestJson<MisskeyNoteResponse>(
    clientFor(context, options)
      .post("api/notes/show", {
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, "post.get") }),
        json: { noteId: id },
      })
      .json(),
    "post.get",
    context,
  );
  return noteFromResponse(response, context);
}

async function listTimeline(
  path: string,
  session: AuthSession | undefined,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  operation: string,
  extraJson: Record<string, unknown> = {},
): Promise<Connection<Post>> {
  const requestedLimit = Math.min(page?.limit ?? 20, 99);
  const response = await requestJson<readonly MisskeyNoteResponse[]>(
    clientFor(context, options)
      .post(path, {
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, operation) }),
        json: {
          limit: requestedLimit + 1,
          ...(page?.after === undefined
            ? {}
            : { untilId: decodeOperationCursor(page.after, context, operation) }),
          ...(page?.before === undefined
            ? {}
            : { sinceId: decodeOperationCursor(page.before, context, operation) }),
          ...extraJson,
        },
      })
      .json(),
    operation,
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Misskey timeline response did not include the expected array.", {
      context,
      operation,
      raw: response,
    });
  }
  const nodes =
    page?.before === undefined
      ? response.slice(0, requestedLimit)
      : response.slice(0, requestedLimit).toReversed();
  return {
    nodes: nodes.map((note) => noteFromResponse(note, context)),
    pageInfo: misskeyPageInfoForOperation(
      nodes,
      response.length > nodes.length,
      page,
      context,
      operation,
    ),
  };
}

async function listHashtagTimeline(
  tag: string,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Connection<Post>> {
  const requestedLimit = Math.min(page?.limit ?? 20, 99);
  const response = await requestJson<readonly MisskeyNoteResponse[]>(
    clientFor(context, options)
      .post("api/notes/search-by-tag", {
        json: {
          tag,
          limit: requestedLimit + 1,
          ...(page?.after === undefined
            ? {}
            : { untilId: decodeOperationCursor(page.after, context, "timeline.hashtag") }),
          ...(page?.before === undefined
            ? {}
            : { sinceId: decodeOperationCursor(page.before, context, "timeline.hashtag") }),
        },
      })
      .json(),
    "timeline.hashtag",
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Misskey hashtag timeline response is malformed.", {
      context,
      operation: "timeline.hashtag",
      raw: response,
    });
  }
  const nodes =
    page?.before === undefined
      ? response.slice(0, requestedLimit)
      : response.slice(0, requestedLimit).toReversed();
  return {
    nodes: nodes.map((note) => noteFromResponse(note, context)),
    pageInfo: misskeyPageInfoForOperation(
      nodes,
      response.length > nodes.length,
      page,
      context,
      "timeline.hashtag",
    ),
  };
}

async function search(
  input: SearchInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<SearchResult> {
  if (input.page?.after !== undefined || input.page?.before !== undefined) {
    const capability = misskeySearchCapability(input.type);
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey search does not expose a reliable cursor.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "search",
        ...(input.type === undefined
          ? { raw: { capabilities: searchCapabilities } }
          : { capability }),
      },
    );
  }
  if (input.resolve === true) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey search does not support ActivityPlug resolve mode.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: misskeySearchOperation(input.type),
        capability: misskeySearchCapability(input.type),
      },
    );
  }
  if (input.type === "hashtags") {
    const hashtags = await requestJson<readonly string[]>(
      clientFor(context, options)
        .post("api/hashtags/search", {
          json: { query: input.query, limit: Math.min(input.page?.limit ?? 20, 100) },
        })
        .json(),
      "search",
      context,
    );
    if (!Array.isArray(hashtags) || hashtags.some((tag) => typeof tag !== "string")) {
      throw invalidRemoteResponse("Misskey hashtag search response is malformed.", {
        context,
        operation: "search",
        raw: hashtags,
      });
    }
    return {
      accounts: [],
      posts: [],
      hashtags: hashtags.map((tag) => ({ name: tag, raw: tag })),
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
      raw: { hashtags },
    };
  }
  const limit = Math.min(input.page?.limit ?? 20, 100);
  const [accounts, posts, hashtags] = await Promise.all([
    input.type === undefined || input.type === "accounts"
      ? requestJson<readonly MisskeyMeResponse[]>(
          clientFor(context, options)
            .post("api/users/search-by-username-and-host", {
              json: { username: input.query, limit },
            })
            .json(),
          "search",
          context,
        )
      : [],
    input.type === undefined || input.type === "posts"
      ? requestJson<readonly MisskeyNoteResponse[]>(
          clientFor(context, options)
            .post("api/notes/search", {
              ...(input.session === undefined
                ? {}
                : { headers: await tokenHeader(input.session, context, "search") }),
              json: { query: input.query, limit },
            })
            .json(),
          "search",
          context,
        )
      : [],
    input.type === undefined
      ? requestJson<readonly string[]>(
          clientFor(context, options)
            .post("api/hashtags/search", {
              json: { query: input.query, limit },
            })
            .json(),
          "search",
          context,
        )
      : [],
  ]);
  if (
    !Array.isArray(accounts) ||
    !Array.isArray(posts) ||
    !Array.isArray(hashtags) ||
    hashtags.some((tag) => typeof tag !== "string")
  ) {
    throw invalidRemoteResponse("Misskey search response is malformed.", {
      context,
      operation: "search",
      raw: { accounts, posts, hashtags },
    });
  }
  return {
    accounts: accounts.map((account) => accountFromResponse(account, context, "search")),
    posts: posts.map((post) => noteFromResponse(post, context)),
    hashtags: hashtags.map((tag) => ({ name: tag, raw: tag })),
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
    raw: { accounts, posts, hashtags },
  };
}

const searchCapabilities = ["search.accounts", "search.posts", "search.hashtags"] as const;

async function uploadMedia(
  input: UploadMediaInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<MediaAttachment> {
  const form = new FormData();
  form.set("file", input.file, input.filename);
  if (input.description !== undefined) form.set("comment", input.description);
  if (input.sensitive !== undefined) form.set("isSensitive", String(input.sensitive));
  const response = await requestJson<MisskeyFileResponse>(
    clientFor(context, options)
      .post("api/drive/files/create", {
        headers: await tokenHeader(input.session, context, "media.upload"),
        body: form,
      })
      .json(),
    "media.upload",
    context,
  );
  const [attachment] = mediaAttachmentFromResponse(response, context, "media.upload");
  if (attachment === undefined) {
    throw invalidRemoteResponse("Misskey media upload response is malformed.", {
      context,
      operation: "media.upload",
      raw: response,
    });
  }
  return attachment;
}

async function updateMedia(
  input: UpdateMediaInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<MediaAttachment> {
  const response = await requestJson<MisskeyFileResponse>(
    clientFor(context, options)
      .post("api/drive/files/update", {
        headers: await tokenHeader(input.session, context, "media.update"),
        json: {
          fileId: input.id,
          ...(input.description === undefined ? {} : { comment: input.description }),
          ...(input.sensitive === undefined ? {} : { isSensitive: input.sensitive }),
        },
      })
      .json(),
    "media.update",
    context,
  );
  const [attachment] = mediaAttachmentFromResponse(response, context, "media.update");
  if (attachment === undefined) {
    throw invalidRemoteResponse("Misskey media update response is malformed.", {
      context,
      operation: "media.update",
      raw: response,
    });
  }
  return attachment;
}

async function deleteMedia(
  input: DeleteMediaInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .post("api/drive/files/delete", {
        headers: await tokenHeader(input.session, context, "media.delete"),
        json: { fileId: input.id },
      })
      .then(() => undefined),
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
  };
}

async function uploadMediaFromUrl(
  input: UploadMediaFromUrlInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<MediaAttachment> {
  const tokenSet = await requireStoredTokenSet(input.session, context, "media.ingestUrl");
  const marker = globalThis.crypto.randomUUID();
  const file = await waitForUrlUpload(
    marker,
    tokenSet.accessToken,
    input.signal,
    context,
    options,
    async () => {
      await requestVoid(
        clientFor(context, options)
          .post("api/drive/files/upload-from-url", {
            headers: await tokenHeader(input.session, context, "media.ingestUrl"),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            json: {
              url: input.url,
              marker,
              ...(input.description === undefined ? {} : { comment: input.description }),
              ...(input.sensitive === undefined ? {} : { isSensitive: input.sensitive }),
            },
          })
          .then(() => undefined),
        "media.ingestUrl",
        context,
      );
    },
  );
  const [attachment] = mediaAttachmentFromResponse(file, context, "media.ingestUrl");
  if (attachment === undefined) {
    throw invalidRemoteResponse("Misskey URL media upload response is malformed.", {
      context,
      operation: "media.ingestUrl",
      raw: file,
    });
  }
  return attachment;
}

async function waitForUrlUpload(
  marker: string,
  accessToken: string,
  signal: AbortSignal | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  startUpload: () => Promise<void>,
): Promise<MisskeyFileResponse> {
  const webSocket = options.webSocket;
  if (typeof webSocket !== "function") {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey URL media upload requires WebSocket support to receive the uploaded file id.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "media.ingestUrl",
        capability: "media.urlIngestion",
      },
    );
  }
  const streamingUrl = new URL("streaming", context.origin);
  streamingUrl.protocol = streamingUrl.protocol === "https:" ? "wss:" : "ws:";
  assertEncryptedWebSocket(streamingUrl, context, "media.ingestUrl");
  streamingUrl.searchParams.set("i", accessToken);
  streamingUrl.searchParams.set("_t", String(Date.now()));

  let socket: WebSocket;
  try {
    const candidate = resolveWebSocketFactoryResult(
      webSocket(streamingUrl.toString(), undefined, signal, { operation: "media.ingestUrl" }),
      signal,
    );
    socket = isWebSocketPromise(candidate) ? await candidate : candidate;
  } catch (error) {
    if (signal?.aborted === true) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    if (error instanceof ActivityPlugError) throw error;
    throw new ActivityPlugError("NETWORK_ERROR", "Misskey streaming connection failed.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "media.ingestUrl",
    });
  }
  return new Promise((resolve, reject) => {
    const channelId = "activityplug-url-upload";
    let settled = false;
    let uploadStarted = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function settle(kind: "resolve", file: MisskeyFileResponse): void;
    function settle(kind: "reject", error: unknown): void;
    function settle(kind: "resolve" | "reject", value: MisskeyFileResponse | unknown): void {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("message", onMessage);
      closeWebSocketSafely(socket);
      if (kind === "resolve") {
        resolve(value as MisskeyFileResponse);
      } else {
        reject(value);
      }
    }

    const onAbort = () =>
      settle(
        "reject",
        signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
      );

    const onOpen = () => {
      socket.send(
        JSON.stringify({ type: "connect", body: { channel: "main", id: channelId, pong: true } }),
      );
    };
    const onError = (event: Event) => {
      settle(
        "reject",
        isWebSocketResourceLimitError(event)
          ? urlUploadFrameLimitError(context)
          : new ActivityPlugError("NETWORK_ERROR", "Misskey streaming connection failed.", {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "media.ingestUrl",
            }),
      );
    };
    const onClose = () => {
      settle(
        "reject",
        new ActivityPlugError(
          "NETWORK_ERROR",
          "Misskey streaming connection closed before URL media upload completed.",
          {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "media.ingestUrl",
          },
        ),
      );
    };
    const onMessage = (event: MessageEvent<string>) => {
      if (webSocketFrameByteLength(event.data) > MAX_STREAMING_QUEUED_BYTES) {
        settle("reject", urlUploadFrameLimitError(context));
        return;
      }
      const message = parseStreamingMessage(event.data);
      if (
        message?.type === "connected" &&
        isRecord(message.body) &&
        message.body.id === channelId
      ) {
        if (!uploadStarted) {
          uploadStarted = true;
          startUpload().catch((error: unknown) => settle("reject", error));
        }
        return;
      }
      if (message?.type !== "channel" || !isRecord(message.body)) return;
      if (message.body.id !== channelId || message.body.type !== "urlUploadFinished") return;
      const payload = message.body.body;
      if (!isRecord(payload) || payload.marker !== marker || !isRecord(payload.file)) return;
      settle("resolve", payload.file);
    };
    timeout = setTimeout(() => {
      settle(
        "reject",
        new ActivityPlugError("TIMEOUT", "Timed out waiting for Misskey URL media upload.", {
          adapter: context.adapterId,
          origin: context.origin,
          operation: "media.ingestUrl",
        }),
      );
    }, 60_000);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    socket.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    if (socket.readyState === 1) onOpen();
    else if (socket.readyState === 3) onClose();
  });
}

function assertEncryptedWebSocket(
  url: URL,
  context: AdapterOperationContext,
  operation: string,
): void {
  if (url.protocol === "wss:") return;
  throw new ActivityPlugError(
    "ORIGIN_NOT_ALLOWED",
    "Authenticated WebSocket connections require HTTPS.",
    { adapter: context.adapterId, origin: context.origin, operation },
  );
}

function isWebSocketPromise(
  candidate: WebSocket | Promise<WebSocket>,
): candidate is Promise<WebSocket> {
  return typeof (candidate as { readonly then?: unknown }).then === "function";
}

function urlUploadFrameLimitError(context: AdapterOperationContext): ActivityPlugError {
  return new ActivityPlugError(
    "REQUEST_LIMIT_EXCEEDED",
    "Misskey URL media upload frame exceeded the byte limit.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "media.ingestUrl",
      raw: { maxFrameBytes: MAX_STREAMING_QUEUED_BYTES },
    },
  );
}

function isWebSocketResourceLimitError(event: Event): boolean {
  if (!("error" in event)) return false;
  const error = event.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ||
      error.code === "WS_ERR_TOO_MANY_BUFFERED_PARTS")
  );
}

function parseStreamingMessage(
  data: string,
): { readonly type?: string; readonly body?: unknown } | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function updateProfile(
  input: UpdateProfileInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Account> {
  if ((input.fields?.length ?? 0) > MAX_PROFILE_FIELDS) {
    throw new ActivityPlugError(
      "REQUEST_LIMIT_EXCEEDED",
      "Profile fields exceeded the configured count limit.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "account.updateProfile",
        raw: { dimension: "profile.fields", limit: MAX_PROFILE_FIELDS },
      },
    );
  }
  const response = await requestJson<MisskeyMeResponse>(
    clientFor(context, options)
      .post("api/i/update", {
        headers: await tokenHeader(input.session, context, "account.updateProfile"),
        json: {
          ...(input.displayName === undefined ? {} : { name: input.displayName }),
          ...(input.note === undefined ? {} : { description: input.note }),
          ...(input.avatarId === undefined ? {} : { avatarId: input.avatarId }),
          ...(input.headerId === undefined ? {} : { bannerId: input.headerId }),
          ...(input.locked === undefined ? {} : { isLocked: input.locked }),
          ...(input.bot === undefined ? {} : { isBot: input.bot }),
          ...(input.fields === undefined
            ? {}
            : {
                fields: input.fields.map((field) => ({
                  name: field.name,
                  value: field.value,
                })),
              }),
        },
      })
      .json(),
    "account.updateProfile",
    context,
  );
  return accountFromResponse(response, context, "account.updateProfile");
}

async function createNote(
  input: CreatePostInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  operation = "post.create",
  capabilityName: CapabilityName = "posts.create",
): Promise<Post> {
  if (input.sensitive === true) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey note creation does not support post-level sensitivity.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
        capability: capabilityName,
      },
    );
  }
  const response = await requestJson<{ readonly createdNote?: MisskeyNoteResponse }>(
    clientFor(context, options)
      .post("api/notes/create", {
        headers: await tokenHeader(input.session, context, operation),
        json: {
          ...(input.content.length === 0 ? {} : { text: input.content }),
          ...(input.visibility === undefined
            ? {}
            : misskeyVisibilityInput(input.visibility, context, operation)),
          ...(input.summary === undefined ? {} : { cw: input.summary }),
          ...(input.replyToId === undefined ? {} : { replyId: input.replyToId }),
          ...(input.quoteOfId === undefined ? {} : { renoteId: input.quoteOfId }),
          ...(input.mediaIds === undefined ? {} : { fileIds: input.mediaIds }),
          ...(input.poll === undefined
            ? {}
            : {
                poll: {
                  choices: input.poll.options,
                  multiple: input.poll.multiple ?? false,
                  ...(input.poll.expiresInSeconds === undefined
                    ? {}
                    : { expiredAfter: input.poll.expiresInSeconds * 1000 }),
                },
              }),
        },
      })
      .json(),
    operation,
    context,
  );
  if (!isRecord(response) || !isRecord(response.createdNote)) {
    throw invalidRemoteResponse("Misskey note creation response is malformed.", {
      context,
      operation,
      raw: response,
    });
  }
  return noteFromResponse(response.createdNote, context);
}

async function deleteNote(
  input: { readonly session: AuthSession; readonly id: string },
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .post("api/notes/delete", {
        headers: await tokenHeader(input.session, context, "post.delete"),
        json: { noteId: input.id },
      })
      .then(() => undefined),
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
  };
}

async function relationship(
  input: RelationshipInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Relationship> {
  const response = await requestJson<MisskeyRelationshipResponse>(
    clientFor(context, options)
      .post("api/users/relation", {
        headers: await tokenHeader(input.session, context, "account.relationships"),
        json: { userId: input.accountId },
      })
      .json(),
    "account.relationships",
    context,
  );
  return relationshipFromResponse(response, context);
}

async function relationshipAction(
  input: RelationshipInput,
  path: string,
  operation: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Relationship> {
  await requestVoid(
    clientFor(context, options)
      .post(`api/${path}`, {
        headers: await tokenHeader(input.session, context, operation),
        json: { userId: input.accountId },
      })
      .then(() => undefined),
    operation,
    context,
  );
  return relationship(input, context, options);
}

async function muteAccount(
  input: MuteAccountInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Relationship> {
  if (input.notifications !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey mute creation does not support notification mute options.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "social.mute",
        capability: "social.mute",
      },
    );
  }
  await requestVoid(
    clientFor(context, options)
      .post("api/mute/create", {
        headers: await tokenHeader(input.session, context, "social.mute"),
        json: {
          userId: input.accountId,
          ...(input.durationSeconds === undefined
            ? {}
            : { expiresAt: Date.now() + input.durationSeconds * 1000 }),
        },
      })
      .then(() => undefined),
    "social.mute",
    context,
  );
  return relationship(input, context, options);
}

async function noteAction(
  input: PostActionInput,
  path: string,
  operation: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Post> {
  await requestVoid(
    clientFor(context, options)
      .post(`api/${path}`, {
        headers: await tokenHeader(input.session, context, operation),
        json: { noteId: input.postId },
      })
      .then(() => undefined),
    operation,
    context,
  );
  return getNote(input.postId, context, options, input.session);
}

async function boostNote(
  input: BoostPostInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Post> {
  return createNote(
    {
      session: input.session,
      content: "",
      quoteOfId: input.postId,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    },
    context,
    options,
    "social.boost",
    "social.boost",
  );
}

async function unboostNote(
  input: PostActionInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Post> {
  await requestVoid(
    clientFor(context, options)
      .post("api/notes/unrenote", {
        headers: await tokenHeader(input.session, context, "social.unboost"),
        json: { noteId: input.postId },
      })
      .then(() => undefined),
    "social.unboost",
    context,
  );
  return getNote(input.postId, context, options, input.session);
}

async function noteReaction(
  input: ReactPostInput,
  path: string,
  operation: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Post> {
  await requestVoid(
    clientFor(context, options)
      .post(`api/${path}`, {
        headers: await tokenHeader(input.session, context, operation),
        json: { noteId: input.postId, reaction: input.emoji },
      })
      .then(() => undefined),
    operation,
    context,
  );
  return getNote(input.postId, context, options, input.session);
}

export const misskeyAdapter = createMisskeyAdapter();
export const misskey = createMisskeyAdapter;

async function registerOAuthClient(
  input: OAuthClientRegistrationInput,
  context: AuthAdapterContext,
): Promise<OAuthClientRegistration> {
  const clientId = input.website ?? input.redirectUris[0];
  if (clientId === undefined || clientId.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires a client identifier URL.",
      errorContext(context, "auth.oauth.registerClient"),
    );
  }
  return {
    clientId,
    redirectUris: input.redirectUris,
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    raw: {
      dynamicRegistration: false,
      clientName: input.clientName,
      website: input.website,
    },
  };
}

async function createAuthorizationUrl(
  input: OAuthAuthorizationUrlInput,
  context: AuthAdapterContext,
): Promise<OAuthAuthorizationRequest> {
  if (input.codeChallenge === undefined || input.codeChallenge.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires PKCE code_challenge.",
      errorContext(context, "auth.oauth.authorizationUrl"),
    );
  }
  if (input.codeChallengeMethod !== undefined && input.codeChallengeMethod !== "S256") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires S256 PKCE.",
      errorContext(context, "auth.oauth.authorizationUrl"),
    );
  }
  const url = new URL("oauth/authorize", slashOrigin(context.origin));
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  const scope = joinScopes(input.scopes ?? input.client.scopes);
  if (scope.length > 0) url.searchParams.set("scope", scope);
  return {
    url,
    state: input.state,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
  };
}

async function exchangeAuthorizationCode(
  input: OAuthCodeExchangeInput,
  context: AuthAdapterContext,
  options: MisskeyAdapterOptions,
): Promise<TokenSet> {
  if (input.codeVerifier === undefined || input.codeVerifier.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires PKCE code_verifier.",
      errorContext(context, "auth.oauth.exchangeCode"),
    );
  }
  const response = await requestJson<MisskeyTokenResponse>(
    clientFor(context, options)
      .post("oauth/token", {
        body: tokenRequestBody({
          grant_type: "authorization_code",
          client_id: input.client.clientId,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }),
      })
      .json(),
    "auth.oauth.exchangeCode",
    context,
  );
  return tokenSetFromResponse(response, context, "auth.oauth.exchangeCode");
}

function tokenSetFromInjectedToken(input: InjectTokenInput): TokenSet {
  // Token import copies only credential fields into the adapter-private token set.
  return {
    accessToken: input.accessToken,
    ...(input.tokenType === undefined ? {} : { tokenType: input.tokenType }),
    ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
  };
}

async function verifyCredentials(
  session: StoredAuthSession,
  context: AuthAdapterContext,
  options: MisskeyAdapterOptions,
): Promise<Account> {
  assertAccessTokenFresh(session.tokenSet, context, "auth.verifyCredentials");
  const response = await requestJson<MisskeyMeResponse>(
    clientFor(context, options)
      .post("api/i", {
        headers: authorizationHeader(session.tokenSet),
        json: {},
      })
      .json(),
    "auth.verifyCredentials",
    context,
  );
  return accountFromResponse(response, context);
}
