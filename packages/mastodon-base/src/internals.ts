import {
  ActivityPlugError,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
  unsupportedOperation,
  type Account,
  type AdapterOperationContext,
  type AuthAdapterContext,
  type InjectTokenInput,
  type BoostPostInput,
  type Connection,
  type MediaAttachment,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationUrlInput,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRevokeInput,
  type PageInput,
  type Post,
  type PostActionInput,
  type PostVisibility,
  type SearchResult,
  type StoredAuthSession,
  type TokenSet,
} from "@activityplug/core";

import {
  assertAccessTokenFresh,
  assertOptionalString,
  authorizationHeader,
  clientFor,
  errorContext,
  invalidRemoteResponse,
  isRecord,
  joinScopes,
  nonEmptyString,
  optionalArray,
  optionalBoolean,
  optionalDateTimeString,
  optionalNonEmptyString,
  optionalNumberArray,
  optionalObject,
  optionalString,
  renamedOptionalBoolean,
  renamedOptionalNumber,
  renamedOptionalString,
  requestJson,
  requestVoid,
  requiredNonEmptyString,
  slashOrigin,
  tokenHeader,
  tokenRequestBody,
  tokenSetFromResponse,
} from "./transport.js";
import {
  type MastodonAccountFieldResponse,
  type MastodonAccountResponse,
  type MastodonApplicationResponse,
  type MastodonBaseAdapterOptions,
  type MastodonMediaAttachmentResponse,
  type MastodonPollResponse,
  type MastodonStatusResponse,
  type MastodonTokenResponse,
} from "./types.js";

export {
  assertAccessTokenFresh,
  assertOptionalString,
  assertRecordResponse,
  authorizationHeader,
  absoluteRemoteUrl,
  clientFor,
  errorCodeForStatus,
  errorContext,
  expiresAt,
  invalidRemoteResponse,
  isRecord,
  joinScopes,
  nonEmptyString,
  optionalArray,
  optionalBoolean,
  optionalDateTimeString,
  optionalNonEmptyString,
  optionalNumber,
  optionalNumberArray,
  optionalObject,
  optionalString,
  optionalStringArray,
  parseJsonArray,
  renamedOptionalNumber,
  renamedOptionalString,
  requestJson,
  requestResponse,
  requestVoid,
  requiredNonEmptyString,
  safeResponseText,
  slashOrigin,
  splitScopes,
  tokenHeader,
  tokenRequestBody,
  tokenSetFromResponse,
  tokenType,
  type MastodonTransportOptions,
} from "./transport.js";
export { relationshipFromResponse } from "./relationship.js";

export async function postAction(
  input: PostActionInput,
  action: "favourite" | "unfavourite" | "bookmark" | "unbookmark" | "unreblog",
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  operation = `social.${action}`,
): Promise<Post> {
  const response = await requestJson<MastodonStatusResponse>(
    clientFor(context, options)
      .post(`api/v1/statuses/${encodeURIComponent(input.postId)}/${action}`, {
        headers: await tokenHeader(input.session, context, operation),
      })
      .json(),
    operation,
    context,
  );
  return postFromResponse(response, context, operation);
}

export async function boostPost(
  input: BoostPostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Post> {
  const response = await requestJson<MastodonStatusResponse>(
    clientFor(context, options)
      .post(`api/v1/statuses/${encodeURIComponent(input.postId)}/reblog`, {
        headers: await tokenHeader(input.session, context, "social.boost"),
        json:
          input.visibility === undefined
            ? {}
            : {
                visibility: mastodonVisibilityInput(
                  input.visibility,
                  context,
                  options,
                  "social.boost",
                ),
              },
      })
      .json(),
    "social.boost",
    context,
  );
  return postFromResponse(response, context, "social.boost");
}

export async function registerOAuthClient(
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

export async function createAuthorizationUrl(
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

export async function exchangeAuthorizationCode(
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

export async function importToken(input: InjectTokenInput): Promise<TokenSet> {
  // Token-import annotations stay in session storage, not in adapter-private credentials.
  return {
    accessToken: input.accessToken,
    ...(input.tokenType === undefined ? {} : { tokenType: input.tokenType }),
    ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
  };
}

export async function refreshToken(
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

export async function revokeToken(
  input: Omit<OAuthRevokeInput, "session"> & { readonly session: StoredAuthSession },
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<void> {
  const credentials = await resolveOAuthRevocationCredentials(input.session, context);
  try {
    await requestVoid(
      clientFor(context, options)
        .post("oauth/revoke", {
          body: tokenRequestBody({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            token: input.session.tokenSet.accessToken,
          }),
        })
        .then(() => undefined),
      "auth.oauth.revoke",
      context,
    );
  } catch (error) {
    // ky's HTTPError retains its Request, including the form body. Recreate the
    // public error without that cause so client credentials cannot escape.
    if (error instanceof ActivityPlugError) {
      throw new ActivityPlugError(error.code, error.message, {
        adapter: error.context.adapter,
        origin: error.context.origin,
        operation: error.context.operation,
        ...(error.context.capability === undefined ? {} : { capability: error.context.capability }),
      });
    }
    throw error;
  }
}

async function resolveOAuthRevocationCredentials(
  session: StoredAuthSession,
  context: AuthAdapterContext,
): Promise<{ readonly clientId: string; readonly clientSecret: string }> {
  const oauthClient = session.metadata?.oauthClient;
  if (!isRecord(oauthClient) || context.credentialLeases === undefined) {
    throw unsupportedOperation("auth.oauth.revoke", errorContext(context, "auth.oauth.revoke"));
  }
  const clientId = oauthClient["clientId"];
  const reference = oauthClient["clientSecret"];
  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    !isRecord(reference) ||
    typeof reference["id"] !== "string" ||
    typeof reference["owner"] !== "string" ||
    typeof reference["version"] !== "number"
  ) {
    throw unsupportedOperation("auth.oauth.revoke", errorContext(context, "auth.oauth.revoke"));
  }
  const clientSecret = await context.credentialLeases.resolve({
    id: reference["id"],
    owner: reference["owner"],
    version: reference["version"],
  });
  if (clientSecret === null) {
    throw unsupportedOperation("auth.oauth.revoke", errorContext(context, "auth.oauth.revoke"));
  }
  return { clientId, clientSecret };
}

export async function verifyCredentials(
  session: StoredAuthSession,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<Account> {
  assertAccessTokenFresh(session.tokenSet, context, "auth.verifyCredentials");
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
    ...(account.pleroma === undefined ? {} : { extensions: { pleroma: account.pleroma } }),
    raw: account,
  };
}

export function postFromResponse(
  response: MastodonStatusResponse,
  context: AdapterOperationContext,
  operation = "posts.read",
): Post {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon status response is missing required fields.", {
      context,
      operation,
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
  const summary = optionalString(
    status.spoiler_text,
    "spoiler_text",
    status,
    context,
    "posts.read",
  );
  const favourited = optionalBoolean(status.favourited, "favourited", status, context, operation);
  const boosted = optionalBoolean(status.reblogged, "reblogged", status, context, operation);
  const bookmarked = optionalBoolean(status.bookmarked, "bookmarked", status, context, operation);
  if (status.media_attachments !== undefined && !Array.isArray(status.media_attachments)) {
    throw invalidRemoteResponse("Mastodon media attachments response must be an array.", {
      context,
      operation,
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
    author: accountFromResponse(status.account, context, operation),
    ...(statusUrl === undefined ? {} : { url: statusUrl }),
    contentHtml: optionalString(status.content, "content", status, context, operation) ?? "",
    createdAt: status.created_at,
    visibility: mastodonVisibility(
      optionalString(status.visibility, "visibility", status, context, operation),
    ),
    sensitive: optionalBoolean(status.sensitive, "sensitive", status, context, operation) ?? false,
    ...(summary === undefined || summary.length === 0 ? {} : { summary }),
    media: mediaAttachmentsFromResponse(status.media_attachments, context, operation),
    ...pollFromResponse(status.poll, status.id, context, operation),
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
              operation,
            ),
          }),
        }),
    ...(status.reblog === null || status.reblog === undefined
      ? {}
      : { boostOf: postReferenceFromResponse(status.reblog, context, operation) }),
    ...quoteRefFromResponse(status, context, operation),
    counts: {
      ...renamedOptionalNumber(
        status.replies_count,
        "replies_count",
        "replies",
        status,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        status.reblogs_count,
        "reblogs_count",
        "reblogs",
        status,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        status.favourites_count,
        "favourites_count",
        "favourites",
        status,
        context,
        operation,
      ),
    },
    ...(favourited === undefined && boosted === undefined && bookmarked === undefined
      ? {}
      : {
          viewerState: {
            ...(favourited === undefined ? {} : { favourited }),
            ...(boosted === undefined ? {} : { boosted }),
            ...(bookmarked === undefined ? {} : { bookmarked }),
          },
        }),
    ...(status.pleroma === undefined ? {} : { extensions: { pleroma: status.pleroma } }),
    raw: status,
  };
}

function quoteRefFromResponse(
  status: MastodonStatusResponse,
  context: AdapterOperationContext,
  operation: string,
): { readonly quoteOf?: Post["ref"] } {
  if (status.quote !== null && status.quote !== undefined) {
    if (!isRecord(status.quote)) {
      throw invalidRemoteResponse("Mastodon status quote response is malformed.", {
        context,
        operation,
        raw: status,
      });
    }
    const quotedStatus = status.quote["quoted_status"];
    if (quotedStatus !== null && quotedStatus !== undefined) {
      if (!isRecord(quotedStatus)) {
        throw invalidRemoteResponse("Mastodon quoted status response is malformed.", {
          context,
          operation,
          raw: status.quote,
        });
      }
      return {
        quoteOf: postReferenceFromResponse(quotedStatus, context, operation),
      };
    }
  }
  if (status.quote_id !== null && status.quote_id !== undefined) {
    return {
      quoteOf: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "post",
        id: requiredNonEmptyString(status.quote_id, "quote_id", status, context, operation),
      }),
    };
  }
  if (isRecord(status.pleroma)) {
    const pleromaQuote = status.pleroma["quote"];
    if (pleromaQuote !== null && pleromaQuote !== undefined) {
      if (!isRecord(pleromaQuote)) {
        throw invalidRemoteResponse("Pleroma quote response is malformed.", {
          context,
          operation,
          raw: status.pleroma,
        });
      }
      return {
        quoteOf: postReferenceFromResponse(pleromaQuote, context, operation),
      };
    }
    const pleromaQuoteId = status.pleroma["quote_id"];
    if (pleromaQuoteId !== null && pleromaQuoteId !== undefined) {
      return {
        quoteOf: createEntityRef({
          adapter: context.adapterId,
          origin: context.origin,
          type: "post",
          id: requiredNonEmptyString(
            pleromaQuoteId,
            "pleroma.quote_id",
            status,
            context,
            operation,
          ),
        }),
      };
    }
  }
  return {};
}

function postReferenceFromResponse(
  response: unknown,
  context: AdapterOperationContext,
  operation: string,
): Post["ref"] {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon related status response is malformed.", {
      context,
      operation,
      raw: response,
    });
  }
  const url = optionalString(response["url"], "url", response, context, operation);
  const uri = optionalString(response["uri"], "uri", response, context, operation);
  return createEntityRef({
    adapter: context.adapterId,
    origin: context.origin,
    type: "post",
    id: requiredNonEmptyString(response["id"], "id", response, context, operation),
    rawUrl: url ?? uri,
  });
}

export function mediaAttachmentFromResponse(
  response: MastodonMediaAttachmentResponse,
  context: AdapterOperationContext,
  operation = "posts.read",
): MediaAttachment {
  if (!isRecord(response) || !nonEmptyString(response.id) || !nonEmptyString(response.url)) {
    throw invalidRemoteResponse("Mastodon media attachment response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  const attachment = response as unknown as MastodonMediaAttachmentResponse & {
    readonly id: string;
    readonly url: string;
  };
  assertOptionalString(attachment.preview_url, "preview_url", attachment, context, operation);
  assertOptionalString(attachment.description, "description", attachment, context, operation);
  assertOptionalString(attachment.blurhash, "blurhash", attachment, context, operation);
  const meta = optionalObject(attachment.meta, "meta", attachment, context, operation);
  const original = optionalObject(meta?.original, "meta.original", attachment, context, operation);
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "media",
      id: attachment.id,
      rawUrl: attachment.url,
    }),
    type: mediaAttachmentType(
      optionalString(attachment.type, "type", attachment, context, operation),
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
      operation,
    ),
    ...renamedOptionalNumber(
      original?.height,
      "meta.original.height",
      "height",
      attachment,
      context,
      operation,
    ),
    raw: attachment,
  };
}

export function mediaAttachmentsFromResponse(
  response: readonly MastodonMediaAttachmentResponse[] | undefined,
  context: AdapterOperationContext,
  operation = "posts.read",
): readonly MediaAttachment[] {
  if (response === undefined) return [];
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Mastodon media attachments response must be an array.", {
      context,
      operation,
      raw: response,
    });
  }
  return response.map((attachment) => mediaAttachmentFromResponse(attachment, context, operation));
}

export function pollFromResponse(
  response: MastodonPollResponse | null | undefined,
  statusId: string,
  context: AdapterOperationContext,
  operation = "posts.read",
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
      operation,
      raw: response,
    });
  }
  const poll = response as unknown as MastodonPollResponse & {
    readonly id: string;
    readonly expired: boolean;
    readonly multiple: boolean;
    readonly options: readonly NonNullable<MastodonPollResponse["options"]>[number][];
  };
  const ownVotes = optionalNumberArray(poll.own_votes, "own_votes", poll, context, operation);
  return {
    poll: {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "poll",
        id: poll.id.length === 0 ? `${statusId}:poll` : poll.id,
      }),
      ...renamedOptionalString(
        optionalDateTimeString(poll.expires_at, "expires_at", poll, context, operation),
        "expires_at",
        "expiresAt",
        poll,
        context,
        operation,
      ),
      expired: poll.expired,
      multiple: poll.multiple,
      ...renamedOptionalNumber(
        poll.votes_count,
        "votes_count",
        "votesCount",
        poll,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        poll.voters_count,
        "voters_count",
        "votersCount",
        poll,
        context,
        operation,
      ),
      ...renamedOptionalBoolean(poll.voted, "voted", "voted", poll, context, operation),
      ...(ownVotes === undefined ? {} : { ownVotes }),
      options: poll.options.map((option) => {
        if (!isRecord(option) || typeof option.title !== "string") {
          throw invalidRemoteResponse("Mastodon poll option response is missing required fields.", {
            context,
            operation,
            raw: option,
          });
        }
        const pollOption = option as {
          readonly title: string;
          readonly votes_count?: number | null;
        };
        return {
          title: pollOption.title,
          ...renamedOptionalNumber(
            pollOption.votes_count,
            "votes_count",
            "votesCount",
            pollOption,
            context,
            operation,
          ),
        };
      }),
      ...(poll.pleroma === undefined ? {} : { extensions: { pleroma: poll.pleroma } }),
      raw: poll,
    },
  };
}

export function accountFieldsFromResponse(
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

export function mediaAttachmentType(value: string | undefined): MediaAttachment["type"] {
  if (value === "image" || value === "video" || value === "audio" || value === "gifv") {
    return value;
  }
  return "unknown";
}

export function mastodonPageInfo(
  response: readonly MastodonStatusResponse[],
  headers: Headers,
  context: AdapterOperationContext,
): Connection<Post>["pageInfo"] {
  return mastodonPageInfoForOperation(response, headers, context, "account.posts");
}

export function mastodonPageInfoForOperation(
  _response: readonly MastodonStatusResponse[],
  headers: Headers,
  context: AdapterOperationContext,
  operation: string,
): Connection<Post>["pageInfo"] {
  const links = parseLinkHeader(headers.get("link"));
  return {
    hasNextPage: links.next !== undefined,
    hasPreviousPage: links.prev !== undefined,
    ...(links.prev === undefined
      ? {}
      : { startCursor: encodeOperationCursor(links.prev, context, operation) }),
    ...(links.next === undefined
      ? {}
      : { endCursor: encodeOperationCursor(links.next, context, operation) }),
  };
}

export function mastodonPageSearchParams(
  page: PageInput | undefined,
  context: AdapterOperationContext,
  operation: string,
): URLSearchParams {
  const searchParams = new URLSearchParams();
  if (page?.limit !== undefined) searchParams.set("limit", String(page.limit));
  if (page?.after !== undefined) {
    searchParams.set("max_id", decodeOperationCursor(page.after, context, operation));
  }
  if (page?.before !== undefined) {
    searchParams.set("min_id", decodeOperationCursor(page.before, context, operation));
  }
  return searchParams;
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

export function encodeOperationCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): string {
  return encodePageCursor({
    adapter: context.adapterId,
    origin: context.origin,
    operation,
    cursor,
  });
}

export function decodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return decodeOperationCursor(cursor, context, "account.posts");
}

export function decodeOperationCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): string {
  return decodePageCursor(cursor, {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
  });
}

export function cursorFromUrl(href: string): string | undefined {
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

export function normalizeHandle(handle: string, context: AdapterOperationContext): string {
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

export function mastodonVisibility(value: string | undefined): Post["visibility"] {
  if (
    value === "public" ||
    value === "unlisted" ||
    value === "direct" ||
    value === "local" ||
    value === "list" ||
    value === "none"
  ) {
    return value;
  }
  if (value === "private") return "followers";
  if (value === "limited") return "list";
  return "unknown";
}

export function mastodonVisibilityInput(
  value: PostVisibility,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  operation: string,
): string {
  if (value === "followers") return "private";
  if (value === "local" && options.supportsLocalVisibility === true) return value;
  if (value === "public" || value === "unlisted" || value === "direct") {
    return value;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "The requested visibility cannot be represented by this adapter.",
    { ...errorContext(context, operation), raw: { visibility: value } },
  );
}

export function hashtagFromResponse(
  response: unknown,
  context: AdapterOperationContext,
): SearchResult["hashtags"][number] {
  if (!isRecord(response) || !nonEmptyString(response.name)) {
    throw invalidRemoteResponse("Mastodon hashtag response is missing required fields.", {
      context,
      operation: "search",
      raw: response,
    });
  }
  const history = optionalArray(response.history, "history", response, context, "search");
  return {
    name: response.name,
    ...renamedOptionalString(response.url, "url", "url", response, context, "search"),
    ...(history === undefined
      ? {}
      : {
          history: history.map((item) => {
            if (!isRecord(item) || typeof item.day !== "string") {
              throw invalidRemoteResponse("Mastodon hashtag history response is malformed.", {
                context,
                operation: "search",
                raw: item,
              });
            }
            return {
              day: item.day,
              ...stringOrNumber(item.uses, "uses", item, context),
              ...stringOrNumber(item.accounts, "accounts", item, context),
              raw: item,
            };
          }),
        }),
    raw: response,
  };
}

export function stringOrNumber(
  value: unknown,
  field: "uses" | "accounts",
  raw: unknown,
  context: AdapterOperationContext,
): Record<typeof field, number> {
  if (value === undefined) return {} as Record<typeof field, number>;
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
    throw invalidRemoteResponse("Mastodon numeric string response is malformed.", {
      context,
      operation: "search",
      raw,
    });
  }
  return { [field]: numberValue } as Record<typeof field, number>;
}
