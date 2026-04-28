import {
  ActivityPlugError,
  createEntityRef,
  type Account,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type AuthAdapterContext,
  type AuthSession,
  type BoostPostInput,
  type CapabilityName,
  type Connection,
  type CreatePostInput,
  type DeletedEntity,
  type InstanceProfile,
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
  type UploadMediaInput,
} from "@activityplug/core";
import ky, { type KyInstance } from "ky";

import { createMisskeyStaticCapabilities } from "./capabilities.js";
import {
  misskeyNodeInfoRelPriority,
  misskeySearchCapability,
  misskeySearchOperation,
  unsupportedMisskeyPostOperation,
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
import {
  absoluteRemoteUrl,
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

export { accountFromResponse, noteFromResponse } from "./internals.js";
export type * from "./types.js";

export function createMisskeyAdapter(options: MisskeyAdapterOptions = {}): ActivityPlugAdapter {
  return {
    metadata: {
      id: "misskey",
      displayName: "Misskey",
      kind: "misskey",
      supportedSoftware: ["misskey"],
      staticCapabilities: createMisskeyStaticCapabilities(),
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
      get: async (input, context) => getNote(input.id, context, options),
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
    },
    search: {
      search: async (input, context) => search(input, context, options),
    },
    media: {
      upload: async (input, context) => uploadMedia(input, context, options),
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
      bookmark: async (_input, context) =>
        unsupportedMisskeyPostOperation(context, "social.bookmark", "social.bookmark"),
      unbookmark: async (_input, context) =>
        unsupportedMisskeyPostOperation(context, "social.unbookmark", "social.bookmark"),
      boost: async (input, context) => boostNote(input, context, options),
      unboost: async (input, context) => unboostNote(input, context, options),
      react: async (input, context) =>
        noteReaction(input, "notes/reactions/create", "social.reaction", context, options),
      unreact: async (input, context) =>
        noteReaction(input, "notes/reactions/delete", "social.unreaction", context, options),
    },
    auth: {
      registerOAuthClient: async (input, context) => registerOAuthClient(input, context),
      createAuthorizationUrl: async (input, context) => createAuthorizationUrl(input, context),
      exchangeAuthorizationCode: async (input, context) =>
        exchangeAuthorizationCode(input, context, options),
      verifyCredentials: async (input, context) =>
        verifyCredentials(input.session, context, options),
    },
  };
}

async function getInstanceProfile(
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<InstanceProfile> {
  const client = clientFor(context, options);
  const [nodeInfo, meta] = await Promise.all([
    getNodeInfo(client, context, options),
    requestJson<MisskeyMetaResponse>(
      client.post("api/meta", { json: { detail: false } }).json(),
      "instance.get",
      context,
    ),
  ]);
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
  options: MisskeyAdapterOptions,
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
    const nodeInfoUrl = absoluteRemoteUrl(href, context, "instance.nodeInfo");
    const nodeInfo = await requestJson<NodeInfoResponse>(
      ky.get(nodeInfoUrl, { fetch: options.fetch, redirect: "manual" }).json(),
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

async function getNote(
  id: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Post> {
  const response = await requestJson<MisskeyNoteResponse>(
    clientFor(context, options)
      .post("api/notes/show", { json: { noteId: id } })
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
  const nodes = response.slice(0, requestedLimit);
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
    raw: { accounts, posts, hashtags },
  };
}

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
  return getNote(input.postId, context, options);
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
  return getNote(input.postId, context, options);
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
  return getNote(input.postId, context, options);
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
