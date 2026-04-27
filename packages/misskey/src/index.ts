import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  type Account,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type AuthAdapterContext,
  type AuthTokenType,
  type Connection,
  type InstanceProfile,
  type MediaAttachment,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationUrlInput,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type PageInput,
  type Post,
  type StoredAuthSession,
  type TokenSet,
} from "@activityplug/core";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

export interface MisskeyAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClient?: KyInstance;
}

export interface MisskeyTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
}

export interface MisskeyMeResponse {
  readonly id?: string;
  readonly username?: string;
  readonly host?: string | null;
  readonly name?: string | null;
  readonly url?: string | null;
  readonly avatarUrl?: string | null;
  readonly bannerUrl?: string | null;
  readonly isBot?: boolean;
  readonly isLocked?: boolean;
  readonly createdAt?: string;
  readonly description?: string | null;
  readonly followersCount?: number;
  readonly followingCount?: number;
  readonly notesCount?: number;
}

export interface MisskeyMetaResponse {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly version?: string;
  readonly langs?: readonly string[];
  readonly maintainerName?: string | null;
  readonly uri?: string;
  readonly disableRegistration?: boolean;
}

export interface NodeInfoLinksResponse {
  readonly links?: readonly {
    readonly rel?: string;
    readonly href?: string;
  }[];
}

export interface NodeInfoResponse {
  readonly software?: {
    readonly name?: string;
    readonly version?: string;
  };
}

export interface MisskeyNoteResponse {
  readonly id?: string;
  readonly uri?: string | null;
  readonly url?: string | null;
  readonly user?: MisskeyMeResponse;
  readonly text?: string | null;
  readonly cw?: string | null;
  readonly createdAt?: string;
  readonly visibility?: string;
  readonly localOnly?: boolean;
  readonly renote?: MisskeyNoteResponse | null;
  readonly files?: readonly MisskeyFileResponse[];
  readonly poll?: MisskeyPollResponse | null;
  readonly replyId?: string | null;
  readonly renoteId?: string | null;
  readonly repliesCount?: number;
  readonly renoteCount?: number;
  readonly reactions?: Readonly<Record<string, number>>;
}

export interface MisskeyPollResponse {
  readonly expiresAt?: string | null;
  readonly multiple?: boolean;
  readonly choices?: readonly {
    readonly text?: string;
    readonly votes?: number;
  }[];
}

export interface MisskeyFileResponse {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly thumbnailUrl?: string | null;
  readonly comment?: string | null;
  readonly blurhash?: string | null;
  readonly properties?: {
    readonly width?: number;
    readonly height?: number;
  };
}

export function createMisskeyAdapter(options: MisskeyAdapterOptions = {}): ActivityPlugAdapter {
  return {
    metadata: {
      id: "misskey",
      displayName: "Misskey",
      kind: "misskey",
      supportedSoftware: ["misskey"],
      staticCapabilities: createCapabilitySet({
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability(
          "unsupported",
          "Misskey OAuth access tokens do not use refresh tokens.",
        ),
        "auth.tokenInjection": capability("supported"),
        "instance.nodeInfo": capability("supported"),
        "accounts.lookupById": capability("supported"),
        "accounts.lookupByHandle": capability("supported"),
        "posts.read": capability("supported"),
      }),
    },
    instances: {
      detect: async (_input, context) => getInstanceProfile(context, options),
      getProfile: async (_input, context) => getInstanceProfile(context, options),
    },
    accounts: {
      getById: async (input, context) => getAccountById(input.id, context, options),
      getByHandle: async (input, context) => getAccountByHandle(input.handle, context, options),
      listPosts: async (input, context) =>
        listAccountPosts(input.accountId, input.page, context, options),
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

function nodeInfoRelPriority(rel: string | undefined): number {
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/2.1") return 3;
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/2.0") return 2;
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/1.0") return 1;
  return 0;
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
): Promise<Connection<Post>> {
  const requestedLimit = page?.limit ?? 20;
  const fetchLimit = requestedLimit + 1;
  const response = await requestJson<readonly MisskeyNoteResponse[]>(
    clientFor(context, options)
      .post("api/users/notes", {
        json: {
          userId: accountId,
          limit: fetchLimit,
          ...(page?.after === undefined ? {} : { untilId: page.after }),
          ...(page?.before === undefined ? {} : { sinceId: page.before }),
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
    pageInfo: misskeyPageInfo(nodes, response.length > nodes.length, page),
  };
}

export const misskeyAdapter = createMisskeyAdapter();

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

export function accountFromResponse(
  response: MisskeyMeResponse,
  context: AuthAdapterContext | AdapterOperationContext,
  operation = "auth.verifyCredentials",
): Account {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Misskey account response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  if (!nonEmptyString(response.id) || !nonEmptyString(response.username)) {
    throw invalidRemoteResponse("Misskey account response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  const account = response as unknown as MisskeyMeResponse & {
    readonly id: string;
    readonly username: string;
  };
  const host = optionalNonEmptyString(account.host, "host", account, context, operation);
  const url = optionalString(account.url, "url", account, context, operation);
  const rawUrl = url ?? `${slashOrigin(context.origin)}@${account.username}`;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: account.id,
      rawUrl,
    }),
    username: account.username,
    acct: host === undefined ? account.username : `${account.username}@${host}`,
    displayName:
      optionalString(account.name, "name", account, context, operation) ?? account.username,
    ...(url === undefined ? {} : { url }),
    ...renamedOptionalString(
      account.avatarUrl,
      "avatarUrl",
      "avatarUrl",
      account,
      context,
      operation,
    ),
    ...renamedOptionalString(
      account.bannerUrl,
      "bannerUrl",
      "headerUrl",
      account,
      context,
      operation,
    ),
    bot: optionalBoolean(account.isBot, "isBot", account, context, operation) ?? false,
    locked: optionalBoolean(account.isLocked, "isLocked", account, context, operation) ?? false,
    ...renamedOptionalString(
      account.createdAt,
      "createdAt",
      "createdAt",
      account,
      context,
      operation,
    ),
    ...renamedOptionalString(
      account.description,
      "description",
      "note",
      account,
      context,
      operation,
    ),
    counts: {
      ...renamedOptionalNumber(
        account.followersCount,
        "followersCount",
        "followers",
        account,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        account.followingCount,
        "followingCount",
        "following",
        account,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        account.notesCount,
        "notesCount",
        "posts",
        account,
        context,
        operation,
      ),
    },
    raw: account,
  };
}

export function noteFromResponse(
  response: MisskeyNoteResponse,
  context: AdapterOperationContext,
): Post {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Misskey note response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  if (
    !nonEmptyString(response.id) ||
    typeof response.user !== "object" ||
    response.user === null ||
    !nonEmptyString(response.createdAt)
  ) {
    throw invalidRemoteResponse("Misskey note response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const note = response as unknown as MisskeyNoteResponse & {
    readonly id: string;
    readonly user: MisskeyMeResponse;
    readonly createdAt: string;
  };
  if (note.files !== undefined && !Array.isArray(note.files)) {
    throw invalidRemoteResponse("Misskey note files response must be an array.", {
      context,
      operation: "posts.read",
      raw: note.files,
    });
  }
  assertOptionalString(note.replyId, "replyId", note, context);
  assertOptionalString(note.renoteId, "renoteId", note, context);
  const noteUrl = optionalString(note.url, "url", note, context, "posts.read");
  const noteUri = optionalString(note.uri, "uri", note, context, "posts.read");
  const text = optionalString(note.text, "text", note, context, "posts.read");
  const cw = optionalString(note.cw, "cw", note, context, "posts.read");
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: note.id,
      rawUrl: noteUrl ?? noteUri,
    }),
    author: accountFromResponse(note.user, context, "posts.read").ref,
    ...(noteUrl === undefined ? {} : { url: noteUrl }),
    contentHtml: escapeHtml(text ?? ""),
    ...(text === undefined ? {} : { contentText: text }),
    createdAt: note.createdAt,
    visibility: misskeyVisibility(
      optionalString(note.visibility, "visibility", note, context, "posts.read"),
      optionalBoolean(note.localOnly, "localOnly", note, context, "posts.read"),
    ),
    sensitive: false,
    ...(cw === undefined ? {} : { spoilerText: cw }),
    attachments: note.files?.flatMap((file) => mediaAttachmentFromResponse(file, context)) ?? [],
    ...pollFromResponse(note.poll, note.id, context),
    ...(note.replyId === null || note.replyId === undefined
      ? {}
      : {
          replyTo: createEntityRef({
            adapter: context.adapterId,
            origin: context.origin,
            type: "post",
            id: requiredNonEmptyString(note.replyId, "replyId", note, context, "posts.read"),
          }),
        }),
    ...(note.renote === null || note.renote === undefined
      ? {}
      : { reblogOf: noteFromResponse(note.renote, context).ref }),
    counts: {
      ...renamedOptionalNumber(
        note.repliesCount,
        "repliesCount",
        "replies",
        note,
        context,
        "posts.read",
      ),
      ...renamedOptionalNumber(
        note.renoteCount,
        "renoteCount",
        "reblogs",
        note,
        context,
        "posts.read",
      ),
      ...(note.reactions === undefined
        ? {}
        : { favourites: reactionCount(note.reactions, note, context) }),
    },
    raw: note,
  };
}

function misskeyPageInfo(
  response: readonly MisskeyNoteResponse[],
  hasExtraItem: boolean,
  page: PageInput | undefined,
): Connection<Post>["pageInfo"] {
  const firstId = response[0]?.id;
  const lastId = response.at(-1)?.id;
  return {
    hasNextPage: page?.before === undefined ? hasExtraItem : true,
    hasPreviousPage: page?.before === undefined ? page?.after !== undefined : hasExtraItem,
    ...(firstId === undefined ? {} : { startCursor: firstId }),
    ...(lastId === undefined ? {} : { endCursor: lastId }),
    ...(lastId === undefined ? {} : { rawNext: lastId }),
    ...(firstId === undefined ? {} : { rawPrevious: firstId }),
    raw: {
      ...(firstId === undefined ? {} : { sinceId: firstId }),
      ...(lastId === undefined ? {} : { untilId: lastId }),
    },
  };
}

function mediaAttachmentFromResponse(
  response: MisskeyFileResponse,
  context: AdapterOperationContext,
): readonly MediaAttachment[] {
  if (!isRecord(response) || !nonEmptyString(response.id) || !nonEmptyString(response.url)) {
    throw invalidRemoteResponse("Misskey file response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const file = response as unknown as MisskeyFileResponse & {
    readonly id: string;
    readonly url: string;
  };
  assertOptionalString(file.thumbnailUrl, "thumbnailUrl", file, context);
  assertOptionalString(file.comment, "comment", file, context);
  assertOptionalString(file.blurhash, "blurhash", file, context);
  return [
    {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "media",
        id: file.id,
        rawUrl: file.url,
      }),
      type: mediaAttachmentType(optionalString(file.type, "type", file, context, "posts.read")),
      url: file.url,
      ...(file.thumbnailUrl === null || file.thumbnailUrl === undefined
        ? {}
        : { previewUrl: file.thumbnailUrl }),
      ...(file.comment === null || file.comment === undefined ? {} : { description: file.comment }),
      ...(file.blurhash === null || file.blurhash === undefined ? {} : { blurhash: file.blurhash }),
      ...renamedOptionalNumber(
        optionalObject(file.properties, "properties", file, context, "posts.read")?.width,
        "properties.width",
        "width",
        file,
        context,
        "posts.read",
      ),
      ...renamedOptionalNumber(
        optionalObject(file.properties, "properties", file, context, "posts.read")?.height,
        "properties.height",
        "height",
        file,
        context,
        "posts.read",
      ),
      raw: file,
    },
  ];
}

function pollFromResponse(
  response: MisskeyPollResponse | null | undefined,
  noteId: string,
  context: AdapterOperationContext,
): { readonly poll?: import("@activityplug/core").Poll } {
  if (response === null || response === undefined) return {};
  if (
    !isRecord(response) ||
    typeof response.multiple !== "boolean" ||
    !Array.isArray(response.choices)
  ) {
    throw invalidRemoteResponse("Misskey poll response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const poll = response as unknown as MisskeyPollResponse & {
    readonly multiple: boolean;
    readonly choices: readonly NonNullable<MisskeyPollResponse["choices"]>[number][];
  };
  return {
    poll: {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "poll",
        id: `${noteId}:poll`,
      }),
      ...renamedOptionalString(
        poll.expiresAt,
        "expiresAt",
        "expiresAt",
        poll,
        context,
        "posts.read",
      ),
      expired:
        optionalString(poll.expiresAt, "expiresAt", poll, context, "posts.read") === undefined
          ? false
          : Date.parse(
              optionalString(poll.expiresAt, "expiresAt", poll, context, "posts.read") ?? "",
            ) <= Date.now(),
      multiple: poll.multiple,
      options: poll.choices.map((choice) => {
        if (!isRecord(choice) || typeof choice.text !== "string") {
          throw invalidRemoteResponse("Misskey poll choice response is missing required fields.", {
            context,
            operation: "posts.read",
            raw: choice,
          });
        }
        const pollChoice = choice as { readonly text: string; readonly votes?: number };
        return {
          title: pollChoice.text,
          ...renamedOptionalNumber(
            pollChoice.votes,
            "votes",
            "votesCount",
            pollChoice,
            context,
            "posts.read",
          ),
        };
      }),
      raw: poll,
    },
  };
}

function reactionCount(
  reactions: Readonly<Record<string, number>>,
  raw: unknown,
  context: AdapterOperationContext,
): number {
  if (!isRecord(reactions)) {
    throw invalidRemoteResponse("Misskey reactions response must be an object.", {
      context,
      operation: "posts.read",
      raw,
    });
  }
  return Object.values(reactions).reduce((sum, count) => {
    if (typeof count !== "number") {
      throw invalidRemoteResponse("Misskey reaction count must be numeric.", {
        context,
        operation: "posts.read",
        raw,
      });
    }
    return sum + count;
  }, 0);
}

function mediaAttachmentType(value: string | undefined): MediaAttachment["type"] {
  if (value?.startsWith("image/") === true) return "image";
  if (value?.startsWith("video/") === true) return "video";
  if (value?.startsWith("audio/") === true) return "audio";
  return "unknown";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function misskeyVisibility(
  value: string | undefined,
  localOnly: boolean | undefined,
): Post["visibility"] {
  if (localOnly === true) return "local";
  if (value === "public") return "public";
  if (value === "home") return "unlisted";
  if (value === "followers") return "followers";
  if (value === "specified") return "direct";
  return "unknown";
}

function parseHandle(
  handle: string,
  origin: string,
): { readonly username: string; readonly host?: string } {
  const normalized = handle.startsWith("@") ? handle.slice(1) : handle;
  const parts = normalized.split("@");
  const [username, host] = parts;
  if (username === undefined || username.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Account handle must include a username.", {
      origin,
      operation: "account.lookup",
    });
  }
  if (parts.length > 2 || (parts.length === 2 && (host === undefined || host.length === 0))) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Account handle host is malformed.", {
      origin,
      operation: "account.lookup",
    });
  }
  const localHost = new URL(origin).host;
  if (host === undefined || host === localHost) return { username };
  return { username, host };
}

function clientFor(
  context: AuthAdapterContext | AdapterOperationContext,
  options: MisskeyAdapterOptions,
): KyInstance {
  return (
    options.httpClient ??
    ky.create({ prefix: context.origin, fetch: options.fetch, redirect: "manual" })
  );
}

function authorizationHeader(tokenSet: TokenSet): Record<string, string> {
  return {
    Authorization: `${tokenSet.tokenType ?? "Bearer"} ${tokenSet.accessToken}`,
  };
}

function tokenSetFromResponse(
  response: MisskeyTokenResponse,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): TokenSet {
  if (response.access_token === undefined || response.access_token.length === 0) {
    throw invalidRemoteResponse("OAuth token response did not include an access token.", {
      context,
      operation,
      raw: response,
    });
  }
  return {
    accessToken: response.access_token,
    tokenType: tokenType(response.token_type),
    ...(response.scope === undefined ? {} : { scopes: splitScopes(response.scope) }),
    raw: response,
  };
}

function tokenType(value: string | undefined): AuthTokenType {
  if (value === undefined || value.length === 0) return "Bearer";
  if (value.toLowerCase() === "bearer") return "Bearer";
  return value as AuthTokenType;
}

function joinScopes(scopes: readonly string[] | undefined): string {
  return scopes?.join(" ") ?? "";
}

function splitScopes(scopes: string): readonly string[] {
  return scopes.split(/\s+/u).filter((scope) => scope.length > 0);
}

function tokenRequestBody(values: Readonly<Record<string, string | undefined>>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.set(key, value);
  }
  return body;
}

function slashOrigin(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

async function requestJson<T>(
  request: Promise<T>,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<T> {
  try {
    return await request;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new ActivityPlugError(
        "REMOTE_ERROR",
        "Remote ActivityPub software response was not valid JSON.",
        errorContext(context, operation),
        { cause },
      );
    }
    throw await remoteError(cause, operation, context);
  }
}

async function remoteError(
  cause: unknown,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<ActivityPlugError> {
  if (cause instanceof TimeoutError) {
    return new ActivityPlugError(
      "TIMEOUT",
      "Remote ActivityPub software request timed out.",
      errorContext(context, operation),
      { cause },
    );
  }
  if (cause instanceof HTTPError) {
    return new ActivityPlugError(
      errorCodeForStatus(cause.response.status),
      `Remote ActivityPub software request failed with HTTP ${cause.response.status}.`,
      {
        ...errorContext(context, operation),
        raw: {
          status: cause.response.status,
          body: await safeResponseText(cause.response),
        },
      },
      { cause },
    );
  }
  return new ActivityPlugError(
    "NETWORK_ERROR",
    "Remote ActivityPub software request failed before a response was received.",
    errorContext(context, operation),
    { cause },
  );
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

function errorContext(
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): { readonly adapter: string; readonly origin: string; readonly operation: string } {
  return {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
  };
}

async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function invalidRemoteResponse(
  message: string,
  options: {
    readonly context: AuthAdapterContext | AdapterOperationContext;
    readonly operation: string;
    readonly raw: unknown;
  },
): ActivityPlugError {
  return new ActivityPlugError("REMOTE_ERROR", message, {
    ...errorContext(options.context, options.operation),
    raw: options.raw,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecordResponse(
  value: unknown,
  message: string,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): asserts value is Record<string, unknown> {
  if (isRecord(value)) return;
  throw invalidRemoteResponse(message, { context, operation, raw: value });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requiredNonEmptyString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string {
  if (nonEmptyString(value)) return value;
  throw invalidRemoteResponse(`Remote response field must be a non-empty string: ${field}.`, {
    context,
    operation,
    raw,
  });
}

function optionalString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw invalidRemoteResponse(`Remote response field must be a string when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string | undefined {
  const parsed = optionalString(value, field, raw, context, operation);
  if (parsed === undefined) return undefined;
  if (parsed.length > 0) return parsed;
  throw invalidRemoteResponse(`Remote response field must be a non-empty string: ${field}.`, {
    context,
    operation,
    raw,
  });
}

function renamedOptionalString(
  value: unknown,
  sourceField: string,
  targetField: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): Record<string, string> {
  const parsed = optionalString(value, sourceField, raw, context, operation);
  return parsed === undefined ? {} : { [targetField]: parsed };
}

function optionalBoolean(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw invalidRemoteResponse(`Remote response field must be a boolean when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

function optionalNumber(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  throw invalidRemoteResponse(`Remote response field must be a number when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

function renamedOptionalNumber(
  value: unknown,
  sourceField: string,
  targetField: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): Record<string, number> {
  const parsed = optionalNumber(value, sourceField, raw, context, operation);
  return parsed === undefined ? {} : { [targetField]: parsed };
}

function optionalStringArray(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): readonly string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw invalidRemoteResponse(
    `Remote response field must be a string array when present: ${field}.`,
    {
      context,
      operation,
      raw,
    },
  );
}

function optionalArray(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): readonly unknown[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  throw invalidRemoteResponse(`Remote response field must be an array when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

function optionalObject(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (isRecord(value)) return value;
  throw invalidRemoteResponse(`Remote response field must be an object when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

function absoluteRemoteUrl(
  href: string,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string {
  if (href.length === 0) {
    throw new ActivityPlugError("REMOTE_ERROR", "Remote NodeInfo link href was empty.", {
      ...errorContext(context, operation),
      raw: href,
    });
  }
  try {
    const url = new URL(href, context.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ActivityPlugError(
        "REMOTE_ERROR",
        "Remote NodeInfo link href used an unsupported scheme.",
        {
          ...errorContext(context, operation),
          raw: href,
        },
      );
    }
    if (url.origin !== new URL(context.origin).origin) {
      throw new ActivityPlugError(
        "REMOTE_ERROR",
        "Remote NodeInfo link href must stay on the instance origin.",
        {
          ...errorContext(context, operation),
          raw: href,
        },
      );
    }
    return url.toString();
  } catch (cause) {
    if (cause instanceof ActivityPlugError) throw cause;
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Remote NodeInfo link href was malformed.",
      { ...errorContext(context, operation), raw: href },
      { cause },
    );
  }
}

function assertOptionalString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
): void {
  if (value === null || value === undefined || typeof value === "string") return;
  throw invalidRemoteResponse(`Remote response field must be a string when present: ${field}.`, {
    context,
    operation: "posts.read",
    raw,
  });
}
