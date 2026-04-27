import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
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
  type OAuthRevokeInput,
  type PageInput,
  type Post,
  type StoredAuthSession,
  type TokenSet,
} from "@activityplug/core";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

export interface MastodonBaseAdapterOptions {
  readonly id: string;
  readonly displayName: string;
  readonly supportedSoftware: readonly string[];
  readonly documentationUrl?: string;
  readonly kind?: "mastodon" | "mastodon-compatible";
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClient?: KyInstance;
  readonly supportsRefreshToken?: boolean;
}

export interface MastodonApplicationResponse {
  readonly id?: string;
  readonly name?: string;
  readonly website?: string | null;
  readonly redirect_uri?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly vapid_key?: string;
}

export interface MastodonTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly created_at?: number;
  readonly expires_in?: number | null;
  readonly refresh_token?: string;
}

export interface MastodonAccountResponse {
  readonly id?: string;
  readonly username?: string;
  readonly acct?: string;
  readonly display_name?: string;
  readonly url?: string;
  readonly avatar?: string;
  readonly header?: string;
  readonly bot?: boolean;
  readonly locked?: boolean;
  readonly created_at?: string;
  readonly note?: string;
  readonly followers_count?: number;
  readonly following_count?: number;
  readonly statuses_count?: number;
  readonly fields?: readonly MastodonAccountFieldResponse[];
}

export interface MastodonAccountFieldResponse {
  readonly name?: string;
  readonly value?: string;
  readonly verified_at?: string | null;
}

export interface MastodonInstanceResponse {
  readonly domain?: string;
  readonly uri?: string;
  readonly title?: string;
  readonly version?: string;
  readonly source_url?: string;
  readonly description?: string;
  readonly languages?: readonly string[];
  readonly registrations?: {
    readonly enabled?: boolean;
    readonly approval_required?: boolean;
    readonly invite_required?: boolean;
  };
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
    readonly repository?: string;
    readonly homepage?: string;
  };
}

export interface MastodonStatusResponse {
  readonly id?: string;
  readonly uri?: string;
  readonly url?: string | null;
  readonly account?: MastodonAccountResponse;
  readonly content?: string;
  readonly created_at?: string;
  readonly visibility?: string;
  readonly sensitive?: boolean;
  readonly spoiler_text?: string;
  readonly media_attachments?: readonly MastodonMediaAttachmentResponse[];
  readonly poll?: MastodonPollResponse | null;
  readonly in_reply_to_id?: string | null;
  readonly reblog?: MastodonStatusResponse | null;
  readonly replies_count?: number;
  readonly reblogs_count?: number;
  readonly favourites_count?: number;
}

export interface MastodonPollResponse {
  readonly id?: string;
  readonly expires_at?: string | null;
  readonly expired?: boolean;
  readonly multiple?: boolean;
  readonly votes_count?: number;
  readonly voters_count?: number | null;
  readonly voted?: boolean;
  readonly own_votes?: readonly number[];
  readonly options?: readonly {
    readonly title?: string;
    readonly votes_count?: number | null;
  }[];
}

export interface MastodonMediaAttachmentResponse {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly preview_url?: string | null;
  readonly description?: string | null;
  readonly blurhash?: string | null;
  readonly meta?: {
    readonly original?: {
      readonly width?: number;
      readonly height?: number;
    };
  };
}

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
        "accounts.lookupById": capability("supported"),
        "accounts.lookupByHandle": capability("supported"),
        "posts.read": capability("supported"),
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
        listAccountPosts(input.accountId, input.page, context, options),
    },
    auth: {
      registerOAuthClient: async (input, context) => registerOAuthClient(input, context, options),
      createAuthorizationUrl: async (input, context) => createAuthorizationUrl(input, context),
      exchangeAuthorizationCode: async (input, context) =>
        exchangeAuthorizationCode(input, context, options),
      refreshToken: async (input, context) => refreshToken(input.session, context, options),
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
    getInstanceDocument(client, context),
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

async function registerOAuthClient(
  input: OAuthClientRegistrationInput,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<OAuthClientRegistration> {
  const response = await requestJson<MastodonApplicationResponse>(
    clientFor(context, options)
      .post("api/v1/apps", {
        json: {
          client_name: input.clientName,
          redirect_uris: input.redirectUris.join("\n"),
          scopes: joinScopes(input.scopes),
          ...(input.website === undefined ? {} : { website: input.website }),
        },
      })
      .json(),
    "auth.oauth.registerClient",
    context,
  );
  if (response.client_id === undefined || response.client_id.length === 0) {
    throw invalidRemoteResponse("Registered Mastodon application did not include a client ID.", {
      context,
      operation: "auth.oauth.registerClient",
      raw: response,
    });
  }
  return {
    clientId: response.client_id,
    ...(response.client_secret === undefined ? {} : { clientSecret: response.client_secret }),
    redirectUris: response.redirect_uri?.split("\n") ?? input.redirectUris,
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    raw: response,
  };
}

async function createAuthorizationUrl(
  input: OAuthAuthorizationUrlInput,
  context: AuthAdapterContext,
): Promise<OAuthAuthorizationRequest> {
  const url = new URL("oauth/authorize", slashOrigin(context.origin));
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  const scope = joinScopes(input.scopes ?? input.client.scopes);
  if (scope.length > 0) url.searchParams.set("scope", scope);
  if (input.codeChallenge !== undefined) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", input.codeChallengeMethod ?? "S256");
  }
  return {
    url,
    state: input.state,
    ...(input.codeChallenge === undefined ? {} : { codeChallenge: input.codeChallenge }),
    ...(input.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: input.codeChallengeMethod }),
  };
}

async function exchangeAuthorizationCode(
  input: OAuthCodeExchangeInput,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<TokenSet> {
  const response = await requestJson<MastodonTokenResponse>(
    clientFor(context, options)
      .post("oauth/token", {
        body: tokenRequestBody({
          grant_type: "authorization_code",
          client_id: input.client.clientId,
          client_secret: input.client.clientSecret,
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

async function refreshToken(
  session: StoredAuthSession,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<TokenSet> {
  if (session.tokenSet.refreshToken === undefined || session.tokenSet.refreshToken.length === 0) {
    throw new ActivityPlugError("AUTH_REQUIRED", "A refresh token is required.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "auth.oauth.refresh",
    });
  }
  const response = await requestJson<MastodonTokenResponse>(
    clientFor(context, options)
      .post("oauth/token", {
        body: tokenRequestBody({
          grant_type: "refresh_token",
          refresh_token: session.tokenSet.refreshToken,
        }),
      })
      .json(),
    "auth.oauth.refresh",
    context,
  );
  return tokenSetFromResponse(response, context, "auth.oauth.refresh");
}

async function revokeToken(
  input: Omit<OAuthRevokeInput, "session"> & { readonly session: StoredAuthSession },
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<void> {
  await requestVoid(
    clientFor(context, options)
      .post("oauth/revoke", {
        body: tokenRequestBody({
          token: input.session.tokenSet.accessToken,
          token_type_hint: input.tokenTypeHint,
        }),
      })
      .then(() => undefined),
    "auth.oauth.revoke",
    context,
  );
}

async function verifyCredentials(
  session: StoredAuthSession,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<Account> {
  const response = await requestJson<MastodonAccountResponse>(
    clientFor(context, options)
      .get("api/v1/accounts/verify_credentials", {
        headers: authorizationHeader(session.tokenSet),
      })
      .json(),
    "auth.verifyCredentials",
    context,
  );
  return accountFromResponse(response, context);
}

export function accountFromResponse(
  response: MastodonAccountResponse,
  context: AuthAdapterContext | AdapterOperationContext,
  operation = "auth.verifyCredentials",
): Account {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon account response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  if (!nonEmptyString(response.id) || !nonEmptyString(response.username)) {
    throw invalidRemoteResponse("Mastodon account response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  const account = response as unknown as MastodonAccountResponse & {
    readonly id: string;
    readonly username: string;
  };
  const acct =
    optionalNonEmptyString(account.acct, "acct", account, context, operation) ?? account.username;
  const url = optionalString(account.url, "url", account, context, operation);
  const rawUrl = url ?? `${slashOrigin(context.origin)}@${acct}`;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: account.id,
      rawUrl,
    }),
    username: account.username,
    acct,
    displayName:
      optionalString(account.display_name, "display_name", account, context, operation) ??
      account.username,
    ...(url === undefined ? {} : { url }),
    ...renamedOptionalString(account.avatar, "avatar", "avatarUrl", account, context, operation),
    ...renamedOptionalString(account.header, "header", "headerUrl", account, context, operation),
    bot: optionalBoolean(account.bot, "bot", account, context, operation) ?? false,
    locked: optionalBoolean(account.locked, "locked", account, context, operation) ?? false,
    ...renamedOptionalString(
      account.created_at,
      "created_at",
      "createdAt",
      account,
      context,
      operation,
    ),
    ...renamedOptionalString(account.note, "note", "note", account, context, operation),
    fields: accountFieldsFromResponse(account.fields, context, operation),
    counts: {
      ...renamedOptionalNumber(
        account.followers_count,
        "followers_count",
        "followers",
        account,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        account.following_count,
        "following_count",
        "following",
        account,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        account.statuses_count,
        "statuses_count",
        "posts",
        account,
        context,
        operation,
      ),
    },
    raw: account,
  };
}

export function postFromResponse(
  response: MastodonStatusResponse,
  context: AdapterOperationContext,
): Post {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon status response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  if (
    !nonEmptyString(response.id) ||
    !isRecord(response.account) ||
    typeof response.account.id !== "string" ||
    typeof response.account.username !== "string" ||
    !nonEmptyString(response.created_at)
  ) {
    throw invalidRemoteResponse("Mastodon status response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const status = response as unknown as MastodonStatusResponse & {
    readonly id: string;
    readonly account: MastodonAccountResponse;
    readonly created_at: string;
  };
  assertOptionalString(status.in_reply_to_id, "in_reply_to_id", status, context);
  const statusUrl = optionalString(status.url, "url", status, context, "posts.read");
  const statusUri = optionalString(status.uri, "uri", status, context, "posts.read");
  const spoilerText = optionalString(
    status.spoiler_text,
    "spoiler_text",
    status,
    context,
    "posts.read",
  );
  if (status.media_attachments !== undefined && !Array.isArray(status.media_attachments)) {
    throw invalidRemoteResponse("Mastodon media attachments response must be an array.", {
      context,
      operation: "posts.read",
      raw: status.media_attachments,
    });
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: status.id,
      rawUrl: statusUrl ?? statusUri,
    }),
    author: accountFromResponse(status.account, context, "posts.read").ref,
    ...(statusUrl === undefined ? {} : { url: statusUrl }),
    contentHtml: optionalString(status.content, "content", status, context, "posts.read") ?? "",
    createdAt: status.created_at,
    visibility: mastodonVisibility(
      optionalString(status.visibility, "visibility", status, context, "posts.read"),
    ),
    sensitive:
      optionalBoolean(status.sensitive, "sensitive", status, context, "posts.read") ?? false,
    ...(spoilerText === undefined || spoilerText.length === 0 ? {} : { spoilerText }),
    attachments: mediaAttachmentsFromResponse(status.media_attachments, context),
    ...pollFromResponse(status.poll, status.id, context),
    ...(status.in_reply_to_id === null || status.in_reply_to_id === undefined
      ? {}
      : {
          replyTo: createEntityRef({
            adapter: context.adapterId,
            origin: context.origin,
            type: "post",
            id: requiredNonEmptyString(
              status.in_reply_to_id,
              "in_reply_to_id",
              status,
              context,
              "posts.read",
            ),
          }),
        }),
    ...(status.reblog === null || status.reblog === undefined
      ? {}
      : { reblogOf: postFromResponse(status.reblog, context).ref }),
    counts: {
      ...renamedOptionalNumber(
        status.replies_count,
        "replies_count",
        "replies",
        status,
        context,
        "posts.read",
      ),
      ...renamedOptionalNumber(
        status.reblogs_count,
        "reblogs_count",
        "reblogs",
        status,
        context,
        "posts.read",
      ),
      ...renamedOptionalNumber(
        status.favourites_count,
        "favourites_count",
        "favourites",
        status,
        context,
        "posts.read",
      ),
    },
    raw: status,
  };
}

function mediaAttachmentFromResponse(
  response: MastodonMediaAttachmentResponse,
  context: AdapterOperationContext,
): MediaAttachment {
  if (!isRecord(response) || !nonEmptyString(response.id) || !nonEmptyString(response.url)) {
    throw invalidRemoteResponse("Mastodon media attachment response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const attachment = response as unknown as MastodonMediaAttachmentResponse & {
    readonly id: string;
    readonly url: string;
  };
  assertOptionalString(attachment.preview_url, "preview_url", attachment, context);
  assertOptionalString(attachment.description, "description", attachment, context);
  assertOptionalString(attachment.blurhash, "blurhash", attachment, context);
  const meta = optionalObject(attachment.meta, "meta", attachment, context, "posts.read");
  const original = optionalObject(
    meta?.original,
    "meta.original",
    attachment,
    context,
    "posts.read",
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "media",
      id: attachment.id,
      rawUrl: attachment.url,
    }),
    type: mediaAttachmentType(
      optionalString(attachment.type, "type", attachment, context, "posts.read"),
    ),
    url: attachment.url,
    ...(attachment.preview_url === null || attachment.preview_url === undefined
      ? {}
      : { previewUrl: attachment.preview_url }),
    ...(attachment.description === null || attachment.description === undefined
      ? {}
      : { description: attachment.description }),
    ...(attachment.blurhash === null || attachment.blurhash === undefined
      ? {}
      : { blurhash: attachment.blurhash }),
    ...renamedOptionalNumber(
      original?.width,
      "meta.original.width",
      "width",
      attachment,
      context,
      "posts.read",
    ),
    ...renamedOptionalNumber(
      original?.height,
      "meta.original.height",
      "height",
      attachment,
      context,
      "posts.read",
    ),
    raw: attachment,
  };
}

function mediaAttachmentsFromResponse(
  response: readonly MastodonMediaAttachmentResponse[] | undefined,
  context: AdapterOperationContext,
): readonly MediaAttachment[] {
  if (response === undefined) return [];
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Mastodon media attachments response must be an array.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  return response.map((attachment) => mediaAttachmentFromResponse(attachment, context));
}

function pollFromResponse(
  response: MastodonPollResponse | null | undefined,
  statusId: string,
  context: AdapterOperationContext,
): { readonly poll?: import("@activityplug/core").Poll } {
  if (response === null || response === undefined) return {};
  if (
    !isRecord(response) ||
    !nonEmptyString(response.id) ||
    typeof response.expired !== "boolean" ||
    typeof response.multiple !== "boolean" ||
    !Array.isArray(response.options)
  ) {
    throw invalidRemoteResponse("Mastodon poll response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const poll = response as unknown as MastodonPollResponse & {
    readonly id: string;
    readonly expired: boolean;
    readonly multiple: boolean;
    readonly options: readonly NonNullable<MastodonPollResponse["options"]>[number][];
  };
  const ownVotes = optionalNumberArray(poll.own_votes, "own_votes", poll, context, "posts.read");
  return {
    poll: {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "poll",
        id: poll.id.length === 0 ? `${statusId}:poll` : poll.id,
      }),
      ...renamedOptionalString(
        poll.expires_at,
        "expires_at",
        "expiresAt",
        poll,
        context,
        "posts.read",
      ),
      expired: poll.expired,
      multiple: poll.multiple,
      ...renamedOptionalNumber(
        poll.votes_count,
        "votes_count",
        "votesCount",
        poll,
        context,
        "posts.read",
      ),
      ...renamedOptionalNumber(
        poll.voters_count,
        "voters_count",
        "votersCount",
        poll,
        context,
        "posts.read",
      ),
      ...(optionalBoolean(poll.voted, "voted", poll, context, "posts.read") === undefined
        ? {}
        : { voted: optionalBoolean(poll.voted, "voted", poll, context, "posts.read") }),
      ...(ownVotes === undefined ? {} : { ownVotes }),
      options: poll.options.map((option) => {
        if (!isRecord(option) || typeof option.title !== "string") {
          throw invalidRemoteResponse("Mastodon poll option response is missing required fields.", {
            context,
            operation: "posts.read",
            raw: option,
          });
        }
        const pollOption = option as {
          readonly title: string;
          readonly votes_count?: number | null;
        };
        return {
          title: pollOption.title,
          ...(optionalNumber(
            pollOption.votes_count,
            "votes_count",
            pollOption,
            context,
            "posts.read",
          ) === undefined
            ? {}
            : {
                votesCount: optionalNumber(
                  pollOption.votes_count,
                  "votes_count",
                  pollOption,
                  context,
                  "posts.read",
                ),
              }),
        };
      }),
      raw: poll,
    },
  };
}

function accountFieldsFromResponse(
  response: readonly MastodonAccountFieldResponse[] | undefined,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): readonly { readonly name: string; readonly valueHtml: string; readonly verifiedAt?: string }[] {
  if (response === undefined) return [];
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Mastodon account fields response must be an array.", {
      context,
      operation,
      raw: response,
    });
  }
  return response.map((field) => {
    if (!isRecord(field) || typeof field.name !== "string" || typeof field.value !== "string") {
      throw invalidRemoteResponse("Mastodon account field response is missing required fields.", {
        context,
        operation,
        raw: field,
      });
    }
    const accountField = field as {
      readonly name: string;
      readonly value: string;
      readonly verified_at?: string | null;
    };
    assertOptionalString(accountField.verified_at, "verified_at", accountField, context, operation);
    return {
      name: accountField.name,
      valueHtml: accountField.value,
      ...(accountField.verified_at === null || accountField.verified_at === undefined
        ? {}
        : { verifiedAt: accountField.verified_at }),
    };
  });
}

function mediaAttachmentType(value: string | undefined): MediaAttachment["type"] {
  if (value === "image" || value === "video" || value === "audio" || value === "gifv") {
    return value;
  }
  return "unknown";
}

function mastodonPageInfo(
  response: readonly MastodonStatusResponse[],
  headers: Headers,
  context: AdapterOperationContext,
): Connection<Post>["pageInfo"] {
  const links = parseLinkHeader(headers.get("link"));
  const firstId = response[0]?.id;
  const lastId = response.at(-1)?.id;
  return {
    hasNextPage: links.next !== undefined,
    hasPreviousPage: links.prev !== undefined,
    ...(firstId === undefined ? {} : { startCursor: encodeAccountPostsCursor(firstId, context) }),
    ...(lastId === undefined ? {} : { endCursor: encodeAccountPostsCursor(lastId, context) }),
    ...(links.next === undefined ? {} : { rawNext: encodeAccountPostsCursor(links.next, context) }),
    ...(links.prev === undefined
      ? {}
      : { rawPrevious: encodeAccountPostsCursor(links.prev, context) }),
    raw: links,
  };
}

function parseLinkHeader(value: string | null): { readonly next?: string; readonly prev?: string } {
  if (value === null || value.length === 0) return {};
  const result: { next?: string; prev?: string } = {};
  for (const part of value.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/u.exec(part.trim());
    if (match === null) continue;
    const [, href, rel] = match;
    if (href === undefined || rel === undefined) continue;
    const cursor = cursorFromUrl(href);
    if (cursor === undefined) continue;
    if (rel === "next") result.next = cursor;
    if (rel === "prev") result.prev = cursor;
  }
  return result;
}

function encodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return encodePageCursor({
    adapter: context.adapterId,
    origin: context.origin,
    operation: "account.posts",
    cursor,
  });
}

function decodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return decodePageCursor(cursor, {
    adapter: context.adapterId,
    origin: context.origin,
    operation: "account.posts",
  });
}

function cursorFromUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    return (
      url.searchParams.get("max_id") ??
      url.searchParams.get("min_id") ??
      url.searchParams.get("since_id") ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function normalizeHandle(handle: string, context: AdapterOperationContext): string {
  const normalized = handle.startsWith("@") ? handle.slice(1) : handle;
  if (normalized.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Account handle must include a username.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "account.lookup",
    });
  }
  return normalized;
}

function mastodonVisibility(value: string | undefined): Post["visibility"] {
  if (value === "public" || value === "unlisted" || value === "direct" || value === "local") {
    return value;
  }
  if (value === "private") return "followers";
  return "unknown";
}

function clientFor(
  context: AuthAdapterContext | AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
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
  response: MastodonTokenResponse,
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
    ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
    ...(response.scope === undefined ? {} : { scopes: splitScopes(response.scope) }),
    ...expiresAt(response),
    raw: response,
  };
}

function tokenType(value: string | undefined): AuthTokenType {
  if (value === undefined || value.length === 0) return "Bearer";
  if (value.toLowerCase() === "bearer") return "Bearer";
  return value as AuthTokenType;
}

function expiresAt(response: MastodonTokenResponse): { readonly expiresAt?: string } {
  if (typeof response.expires_in !== "number") return {};
  if (response.expires_in <= 0) return {};
  const createdAt =
    typeof response.created_at === "number" ? response.created_at * 1000 : Date.now();
  return { expiresAt: new Date(createdAt + response.expires_in * 1000).toISOString() };
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

async function parseJsonArray<T>(
  response: Response,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<readonly T[]> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Remote ActivityPub software response was not valid JSON.",
      errorContext(context, operation),
      { cause },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Remote ActivityPub software response did not include the expected array.",
      {
        ...errorContext(context, operation),
        raw: parsed,
      },
    );
  }
  return parsed as readonly T[];
}

async function requestVoid(
  request: Promise<void>,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<void> {
  try {
    await request;
  } catch (cause) {
    throw await remoteError(cause, operation, context);
  }
}

async function requestResponse(
  request: Promise<Response>,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<Response> {
  try {
    return await request;
  } catch (cause) {
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

function optionalNumberArray(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): readonly number[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) return value;
  throw invalidRemoteResponse(
    `Remote response field must be a number array when present: ${field}.`,
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
  operation = "posts.read",
): void {
  if (value === null || value === undefined || typeof value === "string") return;
  throw invalidRemoteResponse(`Remote response field must be a string when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}
