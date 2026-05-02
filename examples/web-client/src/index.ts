import {
  ActivityPlugError,
  parseOAuthCallback,
  validateOAuthCallbackState,
  createActivityPlugClient,
  type Account,
  type AuthSession,
  type ActivityPlugClient,
  type Connection,
  type InstanceProfile,
  type OAuthCallbackInput,
  type OAuthClientRegistration,
  type Post,
  type PostVisibility,
  type Relationship,
  type SearchResult,
} from "@activityplug/core";
import { createHackersPubAdapter } from "@activityplug/hackerspub";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import { createClientUuid } from "./uuid.js";

export type WebClientAdapter = "hackerspub" | "mastodon" | "misskey";

export interface StartAuthInput {
  readonly adapter: WebClientAdapter;
  readonly origin: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly website?: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
  readonly fetch?: typeof globalThis.fetch;
}

export interface StartedAuth {
  readonly adapter: WebClientAdapter;
  readonly origin: string;
  readonly client: OAuthClientRegistration;
  readonly authorizationUrl: URL;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
  readonly fetch?: typeof globalThis.fetch;
}

export interface ExchangeAuthInput {
  readonly startedAuth: StartedAuth;
  readonly callback: OAuthCallbackInput;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
}

export interface ImportTokenInput {
  readonly adapter: WebClientAdapter;
  readonly origin: string;
  readonly accessToken: string;
  readonly scopes?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}

export interface StartHackersPubEmailLoginInput {
  readonly origin: string;
  readonly identifier: string;
  readonly locale?: string;
  readonly verifyUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HackersPubLoginChallenge {
  readonly token: string;
  readonly created: string;
}

export interface CompleteHackersPubEmailLoginInput {
  readonly origin: string;
  readonly token: string;
  readonly code: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface LoginHackersPubByPasskeyInput {
  readonly origin: string;
  readonly useBrowserAutofill?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface DetectInstanceInput {
  readonly adapter: WebClientAdapter;
  readonly origin: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ExchangedAuth {
  readonly session: AuthSession;
  readonly detectInstance: () => Promise<InstanceProfile>;
  readonly verifyViewer: () => Promise<Account>;
  readonly lookupAccountProfile: (handle: string) => Promise<Account | null>;
  readonly listAccountPosts: (accountId: string) => Promise<Connection<Post>>;
  readonly renderHomeTimeline: () => Promise<Connection<Post>>;
  readonly renderPublicTimeline: () => Promise<Connection<Post>>;
  readonly renderLocalTimeline: () => Promise<Connection<Post>>;
  readonly renderHashtagTimeline: (tag: string) => Promise<Connection<Post>>;
  readonly search: (
    query: string,
    type: "accounts" | "posts" | "hashtags",
  ) => Promise<SearchResult>;
  readonly compose: (content: string, visibility?: PostVisibility) => Promise<Post>;
  readonly reply: (postId: string, content: string, visibility?: PostVisibility) => Promise<Post>;
  readonly quote: (postId: string, content: string, visibility?: PostVisibility) => Promise<Post>;
  readonly uploadMedia: (file: Blob, filename?: string) => Promise<string>;
  readonly composeWithMedia: (
    content: string,
    mediaIds: readonly string[],
    visibility?: PostVisibility,
  ) => Promise<Post>;
  readonly deletePost: (id: string) => Promise<void>;
  readonly follow: (accountId: string) => Promise<Relationship>;
  readonly unfollow: (accountId: string) => Promise<Relationship>;
  readonly block: (accountId: string) => Promise<Relationship>;
  readonly mute: (accountId: string) => Promise<Relationship>;
  readonly favourite: (postId: string) => Promise<Post>;
  readonly bookmark: (postId: string) => Promise<Post>;
  readonly boost: (postId: string) => Promise<Post>;
  readonly react: (postId: string, emoji: string) => Promise<Post>;
}

export async function detectInstance(input: DetectInstanceInput): Promise<InstanceProfile> {
  return createClient(input.adapter, input.origin, input.fetch).instances.detect();
}

export async function startAuth(input: StartAuthInput): Promise<StartedAuth> {
  const client = createClient(input.adapter, input.origin, input.fetch);
  const pkce = await resolvePkce(input);
  const registeredClient = await client.auth.registerOAuthClient({
    clientName: input.clientName,
    redirectUris: [input.redirectUri],
    scopes: input.scopes,
    ...(input.website === undefined ? {} : { website: input.website }),
  });
  const authorization = await client.auth.createAuthorizationUrl({
    client: registeredClient,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    state: input.state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
  });
  return {
    adapter: input.adapter,
    origin: input.origin,
    client: registeredClient,
    authorizationUrl: authorization.url,
    redirectUri: input.redirectUri,
    state: authorization.state,
    codeVerifier: pkce.codeVerifier,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  };
}

export async function exchangeAuth(input: ExchangeAuthInput): Promise<ExchangedAuth> {
  const callback = parseOAuthCallback(input.callback);
  validateOAuthCallbackState(callback, {
    expectedState: input.startedAuth.state,
  });
  if (!callback.ok) {
    throw new ActivityPlugError("VALIDATION_FAILED", `OAuth callback failed: ${callback.error}`, {
      operation: "auth.oauth.callback",
      raw: callback,
    });
  }
  const codeVerifier = input.codeVerifier ?? input.startedAuth.codeVerifier;
  const client = createClient(
    input.startedAuth.adapter,
    input.startedAuth.origin,
    input.startedAuth.fetch,
  );
  const session = await client.auth.exchangeAuthorizationCode({
    client: input.startedAuth.client,
    code: callback.code,
    redirectUri: input.redirectUri,
    ...(codeVerifier === undefined ? {} : { codeVerifier }),
  });
  return exchangedAuthFromSession(client, session);
}

export async function importToken(input: ImportTokenInput): Promise<ExchangedAuth> {
  const client = createClient(input.adapter, input.origin, input.fetch);
  const session = await client.auth.injectToken({
    accessToken: input.accessToken,
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
  });
  return exchangedAuthFromSession(client, session);
}

export async function startHackersPubEmailLogin(
  input: StartHackersPubEmailLoginInput,
): Promise<HackersPubLoginChallenge> {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "HackersPub login identifier is required.", {
      adapter: "hackerspub",
      origin: input.origin,
      operation: "auth.hackerspub.emailLogin",
    });
  }
  const byEmail = trimmedIdentifier.includes("@");
  const data = await executeHackersPubGraphQL<{
    readonly loginByEmail?: HackersPubLoginResult;
    readonly loginByUsername?: HackersPubLoginResult;
  }>({
    origin: input.origin,
    fetch: input.fetch,
    query: byEmail
      ? `
        mutation ($email: String!, $locale: Locale!, $verifyUrl: URITemplate!) {
          loginByEmail(email: $email, locale: $locale, verifyUrl: $verifyUrl) {
            __typename
            ... on LoginChallenge {
              token
              created
            }
            ... on AccountNotFoundError {
              query
            }
          }
        }
      `
      : `
        mutation ($username: String!, $locale: Locale!, $verifyUrl: URITemplate!) {
          loginByUsername(username: $username, locale: $locale, verifyUrl: $verifyUrl) {
            __typename
            ... on LoginChallenge {
              token
              created
            }
            ... on AccountNotFoundError {
              query
            }
          }
        }
      `,
    variables: {
      locale: input.locale ?? "en",
      verifyUrl: input.verifyUrl,
      ...(byEmail ? { email: trimmedIdentifier } : { username: trimmedIdentifier }),
    },
    operation: "auth.hackerspub.emailLogin",
  });
  return loginChallengeFromResult(
    byEmail ? data.loginByEmail : data.loginByUsername,
    input.origin,
    "auth.hackerspub.emailLogin",
  );
}

export async function completeHackersPubEmailLogin(
  input: CompleteHackersPubEmailLoginInput,
): Promise<ExchangedAuth> {
  const data = await executeHackersPubGraphQL<{
    readonly completeLoginChallenge?: HackersPubSession | null;
  }>({
    origin: input.origin,
    fetch: input.fetch,
    query: `
      mutation ($token: UUID!, $code: String!) {
        completeLoginChallenge(token: $token, code: $code) {
          id
        }
      }
    `,
    variables: { token: input.token, code: input.code },
    operation: "auth.hackerspub.completeEmailLogin",
  });
  if (data.completeLoginChallenge === null || data.completeLoginChallenge === undefined) {
    throw new ActivityPlugError("AUTH_REQUIRED", "HackersPub login challenge was not accepted.", {
      adapter: "hackerspub",
      origin: input.origin,
      operation: "auth.hackerspub.completeEmailLogin",
    });
  }
  return importToken({
    adapter: "hackerspub",
    origin: input.origin,
    accessToken: data.completeLoginChallenge.id,
    fetch: input.fetch,
  });
}

export async function loginHackersPubByPasskey(
  input: LoginHackersPubByPasskeyInput,
): Promise<ExchangedAuth> {
  if (!canUseHackersPubPasskey(input.origin)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "HackersPub passkey login must run on the exact HackersPub origin.",
      {
        adapter: "hackerspub",
        origin: input.origin,
        operation: "auth.hackerspub.passkeyLogin",
      },
    );
  }
  const sessionId = createClientUuid();
  const options = await executeHackersPubGraphQL<{
    readonly getPasskeyAuthenticationOptions: PublicKeyCredentialRequestOptionsJSON;
  }>({
    origin: input.origin,
    fetch: input.fetch,
    query: `
      mutation ($sessionId: UUID!) {
        getPasskeyAuthenticationOptions(sessionId: $sessionId)
      }
    `,
    variables: { sessionId },
    operation: "auth.hackerspub.passkeyOptions",
  });
  const authenticationResponse = await startAuthentication({
    optionsJSON: options.getPasskeyAuthenticationOptions,
    useBrowserAutofill: input.useBrowserAutofill ?? false,
  });
  const data = await executeHackersPubGraphQL<{
    readonly loginByPasskey?: HackersPubSession | null;
  }>({
    origin: input.origin,
    fetch: input.fetch,
    query: `
      mutation ($sessionId: UUID!, $authenticationResponse: JSON!) {
        loginByPasskey(sessionId: $sessionId, authenticationResponse: $authenticationResponse) {
          id
        }
      }
    `,
    variables: { sessionId, authenticationResponse },
    operation: "auth.hackerspub.passkeyLogin",
  });
  if (data.loginByPasskey === null || data.loginByPasskey === undefined) {
    throw new ActivityPlugError("AUTH_REQUIRED", "HackersPub passkey login was not accepted.", {
      adapter: "hackerspub",
      origin: input.origin,
      operation: "auth.hackerspub.passkeyLogin",
    });
  }
  return importToken({
    adapter: "hackerspub",
    origin: input.origin,
    accessToken: data.loginByPasskey.id,
    fetch: input.fetch,
  });
}

export function canUseHackersPubPasskey(
  origin: string,
  clientOrigin: string | undefined = globalThis.location?.origin,
): boolean {
  if (clientOrigin === undefined) return false;
  try {
    return clientOrigin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function exchangedAuthFromSession(client: ActivityPlugClient, session: AuthSession): ExchangedAuth {
  return {
    session,
    detectInstance: () => client.instances.detect(),
    verifyViewer: async () => (await client.auth.verifyCredentials(session)).account,
    lookupAccountProfile: (handle) => client.accounts.getByHandle({ handle }),
    listAccountPosts: (accountId) => client.accounts.listPosts({ accountId, session }),
    renderHomeTimeline: () => client.timelines.home({ session }),
    renderPublicTimeline: () => client.timelines.public({}),
    renderLocalTimeline: () => client.timelines.local({}),
    renderHashtagTimeline: (tag) => client.timelines.hashtag({ tag }),
    search: (query, type) => client.search.search({ query, type, session }),
    compose: (content, visibility) =>
      client.posts.create({ session, content, visibility: visibility ?? "public" }),
    reply: (postId, content, visibility) =>
      client.posts.create({
        session,
        content,
        replyToId: postId,
        visibility: visibility ?? "public",
      }),
    quote: (postId, content, visibility) =>
      client.posts.create({
        session,
        content,
        quoteOfId: postId,
        visibility: visibility ?? "public",
      }),
    uploadMedia: async (file, filename) =>
      (
        await client.media.upload({
          session,
          file,
          ...(filename === undefined ? {} : { filename }),
        })
      ).ref.id,
    composeWithMedia: (content, mediaIds, visibility) =>
      client.posts.create({ session, content, mediaIds, visibility: visibility ?? "public" }),
    deletePost: async (id) => {
      await client.posts.delete({ session, id });
    },
    follow: (accountId) => client.social.follow({ session, accountId }),
    unfollow: (accountId) => client.social.unfollow({ session, accountId }),
    block: (accountId) => client.social.block({ session, accountId }),
    mute: (accountId) => client.social.mute({ session, accountId }),
    favourite: (postId) => client.social.favourite({ session, postId }),
    bookmark: (postId) => client.social.bookmark({ session, postId }),
    boost: (postId) => client.social.boost({ session, postId }),
    react: (postId, emoji) => client.social.react({ session, postId, emoji }),
  };
}

function createClient(
  adapter: WebClientAdapter,
  origin: string,
  fetch: typeof globalThis.fetch | undefined,
): ActivityPlugClient {
  const selectedAdapter =
    adapter === "hackerspub"
      ? createHackersPubAdapter({ fetch })
      : adapter === "mastodon"
        ? createMastodonAdapter({ fetch })
        : createMisskeyAdapter({ fetch });
  return createActivityPlugClient({
    adapter: selectedAdapter,
    origin,
  });
}

interface PkceMaterial {
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

async function resolvePkce(input: StartAuthInput): Promise<PkceMaterial> {
  if (input.codeChallenge !== undefined) {
    return {
      ...(input.codeVerifier === undefined ? {} : { codeVerifier: input.codeVerifier }),
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod ?? "S256",
    };
  }
  const codeVerifier = input.codeVerifier ?? createCodeVerifier();
  if (input.codeChallengeMethod === "plain") {
    return {
      codeVerifier,
      codeChallenge: codeVerifier,
      codeChallengeMethod: "plain",
    };
  }
  return {
    codeVerifier,
    codeChallenge: await s256Challenge(codeVerifier),
    codeChallengeMethod: "S256",
  };
}

function createCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function s256Challenge(codeVerifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

type HackersPubLoginResult =
  | {
      readonly __typename: "LoginChallenge";
      readonly token: string;
      readonly created: string;
    }
  | {
      readonly __typename: "AccountNotFoundError";
      readonly query: string;
    };

interface HackersPubSession {
  readonly id: string;
}

function loginChallengeFromResult(
  result: HackersPubLoginResult | undefined,
  origin: string,
  operation: string,
): HackersPubLoginChallenge {
  if (result?.__typename === "LoginChallenge") {
    return {
      token: result.token,
      created: result.created,
    };
  }
  if (result?.__typename === "AccountNotFoundError") {
    throw new ActivityPlugError("NOT_FOUND", "HackersPub account was not found.", {
      adapter: "hackerspub",
      origin,
      operation,
      raw: result,
    });
  }
  throw new ActivityPlugError("REMOTE_ERROR", "HackersPub login response was malformed.", {
    adapter: "hackerspub",
    origin,
    operation,
    raw: result,
  });
}

async function executeHackersPubGraphQL<T>(input: {
  readonly origin: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly operation: string;
}): Promise<T> {
  const fetch = input.fetch ?? globalThis.fetch;
  const origin = new URL(input.origin).origin;
  const response = await fetch(new URL("/graphql", origin).href, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });
  const raw = (await response.json()) as {
    readonly data?: T;
    readonly errors?: readonly unknown[];
  };
  if (!response.ok || raw.errors !== undefined || raw.data === undefined) {
    throw new ActivityPlugError("REMOTE_ERROR", "HackersPub GraphQL login request failed.", {
      adapter: "hackerspub",
      origin: input.origin,
      operation: input.operation,
      raw,
    });
  }
  return raw.data;
}
