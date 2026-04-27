import {
  ActivityPlugError,
  capabilityNames,
  parseOAuthCallback,
  type AuthSession,
  type Account,
  type CapabilityDecision,
  type CapabilitySet,
  type Connection,
  type EntityRef,
  type InstanceProfile,
  type InjectTokenInput,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthCallbackStateBinding,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthRevokeInput,
  type Post,
  type VerifyCredentialsResult,
} from "@activityplug/core";

import { type AuthStartResult } from "../auth/endpoints.js";

export const activityPlugApiVersion = "v1";

export interface InstanceSelector {
  readonly adapter?: string;
  readonly origin: string;
}

export interface HealthStatus {
  readonly ok: boolean;
  readonly version: string;
}

export interface ActivityPlugApiService {
  readonly health: () => Promise<HealthStatus> | HealthStatus;
  readonly capabilities: (input: InstanceSelector) => Promise<CapabilitySet> | CapabilitySet;
  readonly instances: ActivityPlugInstanceApiService;
  readonly accounts: ActivityPlugAccountApiService;
  readonly auth: ActivityPlugAuthApiService;
  readonly viewer: (input: ViewerInput) => Promise<VerifyCredentialsResult>;
}

export interface ActivityPlugInstanceApiService {
  readonly detect: (input: InstanceSelector) => Promise<InstanceProfile>;
  readonly get: (input: InstanceSelector) => Promise<InstanceProfile>;
}

export interface ActivityPlugAccountApiService {
  readonly get: (input: AccountIdRequest) => Promise<Account>;
  readonly lookup: (input: AccountLookupRequest) => Promise<Account | null>;
  readonly posts: (input: AccountPostsRequest) => Promise<Connection<Post>>;
}

export interface ActivityPlugAuthApiService {
  readonly importToken: (input: ImportTokenRequest) => Promise<AuthSession>;
  readonly start: (input: AuthStartRequest) => Promise<AuthStartResult>;
  readonly parseCallback: (input: AuthParseCallbackRequest) => OAuthCallbackResult;
  readonly exchange: (input: AuthExchangeRequest) => Promise<AuthSession>;
  readonly refresh: (input: AuthRefreshRequest) => Promise<AuthSession>;
  readonly refreshSession: (input: AuthSessionIdRequest) => Promise<AuthSession>;
  readonly revoke: (input: AuthRevokeRequest) => Promise<void>;
  readonly revokeSession: (input: AuthSessionIdRequest) => Promise<void>;
}

export interface CapabilityListItem extends Omit<CapabilityDecision, "raw" | "reason"> {
  readonly name: CapabilityDecision["name"];
  readonly reason: string | null;
}

export interface CapabilitySetPayload {
  readonly auth: readonly CapabilityListItem[];
  readonly instance: readonly CapabilityListItem[];
  readonly accounts: readonly CapabilityListItem[];
  readonly posts: readonly CapabilityListItem[];
  readonly timelines: readonly CapabilityListItem[];
  readonly media: readonly CapabilityListItem[];
  readonly social: readonly CapabilityListItem[];
  readonly search: readonly CapabilityListItem[];
  readonly notifications: readonly CapabilityListItem[];
  readonly polls: readonly CapabilityListItem[];
  readonly lists: readonly CapabilityListItem[];
  readonly streaming: readonly CapabilityListItem[];
  readonly admin: readonly CapabilityListItem[];
}

export interface PublicAccount {
  readonly ref: PublicEntityRef;
  readonly username: string;
  readonly handle: string;
  readonly displayName: string;
  readonly url?: string;
  readonly avatarUrl?: string;
  readonly headerUrl?: string;
  readonly fields: readonly PublicAccountField[];
  readonly bot: boolean;
  readonly locked: boolean;
  readonly createdAt?: string;
  readonly bioHtml?: string;
  readonly followersCount?: number;
  readonly followingCount?: number;
  readonly postsCount?: number;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface PublicAccountField {
  readonly name: string;
  readonly valueHtml: string;
  readonly verifiedAt?: string;
}

export interface PublicEntityRef {
  readonly id: string;
  readonly type: string;
  readonly adapter: string;
  readonly origin: string;
  readonly rawId: string;
  readonly rawUrl?: string;
}

export interface PublicAuthSession {
  readonly id: string;
  readonly adapter: string;
  readonly origin: string;
  readonly account?: PublicEntityRef;
  readonly scopes: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly expiresAt?: string;
}

export interface PublicInstanceProfile {
  readonly ref: PublicEntityRef;
  readonly software: {
    readonly name: string;
    readonly version?: string;
    readonly repository?: string;
    readonly homepage?: string;
  };
  readonly title?: string;
  readonly description?: string;
  readonly languages: readonly string[];
  readonly registrations?: {
    readonly enabled: boolean;
    readonly approvalRequired?: boolean;
    readonly inviteRequired?: boolean;
  };
  readonly capabilities: CapabilitySetPayload;
  readonly raw: unknown;
}

export interface PublicPost {
  readonly ref: PublicEntityRef;
  readonly author: PublicEntityRef;
  readonly url?: string;
  readonly contentHtml: string;
  readonly contentText?: string;
  readonly createdAt: string;
  readonly visibility: string;
  readonly sensitive: boolean;
  readonly spoilerText?: string;
  readonly attachments: readonly unknown[];
  readonly poll?: unknown;
  readonly replyTo?: PublicEntityRef;
  readonly quoteOf?: PublicEntityRef;
  readonly reblogOf?: PublicEntityRef;
  readonly counts?: {
    readonly replies?: number;
    readonly reblogs?: number;
    readonly favourites?: number;
  };
  readonly raw: unknown;
}

export interface PublicPageInfo {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor?: string;
  readonly endCursor?: string;
  readonly raw?: unknown;
  readonly rawNext?: string;
  readonly rawPrevious?: string;
}

export interface PublicConnection<Node> {
  readonly nodes: readonly Node[];
  readonly pageInfo: PublicPageInfo;
}

export interface AuthStartPayload {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly scopes?: readonly string[];
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
  readonly callbackBinding?: PublicOAuthCallbackStateBinding;
}

export interface PublicOAuthCallbackStateBinding {
  readonly adapter: string;
  readonly origin: string;
  readonly clientRequestId: string;
}

export interface ParsedAuthCallback {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export type ImportTokenRequest = InstanceSelector & InjectTokenInput;

export interface AuthStartRequest extends InstanceSelector {
  readonly client: OAuthClientRegistrationInput;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly string[];
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

export type AuthParseCallbackRequest = OAuthCallbackInput;

export type AuthExchangeRequest =
  | (InstanceSelector &
      Omit<OAuthCodeExchangeInput, "client" | "code" | "state"> & {
        readonly callback: OAuthCallbackInput;
        readonly expectedState: string;
        readonly expectedBinding: OAuthCallbackStateBinding;
        readonly actualBinding: OAuthCallbackStateBinding;
      })
  | (InstanceSelector &
      Omit<OAuthCodeExchangeInput, "client" | "state"> & {
        readonly client?: OAuthCodeExchangeInput["client"];
        readonly state: string;
      });

export type AuthRefreshRequest = InstanceSelector & OAuthRefreshInput;

export type AuthRevokeRequest = InstanceSelector & OAuthRevokeInput;

export interface AuthSessionIdRequest {
  readonly sessionId: string;
}

export interface ViewerInput {
  readonly sessionId: string;
}

export interface AccountIdRequest {
  readonly id: string;
}

export interface AccountLookupRequest extends InstanceSelector {
  readonly handle: string;
}

export interface PageRequest {
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface AccountPostsRequest {
  readonly id: string;
  readonly page?: PageRequest;
}

export function createDefaultApiService(capabilities: CapabilitySet): ActivityPlugApiService {
  const unsupportedAuth = async (): Promise<never> => {
    throw new ActivityPlugError("AUTH_UNSUPPORTED", "No ActivityPlug auth service is configured.");
  };
  const unsupportedApiOperation = (operation: string) => async (): Promise<never> => {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      `ActivityPlug operation service is not configured: ${operation}.`,
      { operation },
    );
  };
  return {
    health: () => ({ ok: true, version: activityPlugApiVersion }),
    capabilities: () => capabilities,
    instances: {
      detect: unsupportedApiOperation("instance.detect"),
      get: unsupportedApiOperation("instance.get"),
    },
    accounts: {
      get: unsupportedApiOperation("account.get"),
      lookup: unsupportedApiOperation("account.lookup"),
      posts: unsupportedApiOperation("account.posts"),
    },
    auth: {
      importToken: unsupportedAuth,
      start: unsupportedAuth,
      parseCallback: (input) => parseOAuthCallback(input),
      exchange: unsupportedAuth,
      refresh: unsupportedAuth,
      refreshSession: unsupportedAuth,
      revoke: unsupportedAuth,
      revokeSession: unsupportedAuth,
    },
    viewer: unsupportedAuth,
  };
}

export function serializeCapabilitySet(capabilities: CapabilitySet): readonly CapabilityListItem[] {
  return capabilityNames.map((name) => {
    const decision = capabilities[name];
    return {
      name: decision.name,
      status: decision.status,
      source: decision.source,
      reason: decision.reason ?? null,
    };
  });
}

export function serializeCapabilitySetPayload(capabilities: CapabilitySet): CapabilitySetPayload {
  const groups: Record<keyof CapabilitySetPayload, CapabilityListItem[]> = {
    auth: [],
    instance: [],
    accounts: [],
    posts: [],
    timelines: [],
    media: [],
    social: [],
    search: [],
    notifications: [],
    polls: [],
    lists: [],
    streaming: [],
    admin: [],
  };
  for (const capability of serializeCapabilitySet(capabilities)) {
    const group = capability.name.split(".")[0] as keyof CapabilitySetPayload;
    if (group in groups) groups[group].push(capability);
  }
  return groups;
}

export function serializeAccount(account: Account): PublicAccount {
  return {
    ref: serializeEntityRef(account.ref),
    username: account.username,
    handle: account.acct,
    displayName: account.displayName,
    ...(account.url === undefined ? {} : { url: account.url }),
    ...(account.avatarUrl === undefined ? {} : { avatarUrl: account.avatarUrl }),
    ...(account.headerUrl === undefined ? {} : { headerUrl: account.headerUrl }),
    fields: account.fields ?? [],
    bot: account.bot,
    locked: account.locked,
    ...(account.createdAt === undefined ? {} : { createdAt: account.createdAt }),
    ...(account.note === undefined ? {} : { bioHtml: account.note }),
    ...(account.counts?.followers === undefined
      ? {}
      : { followersCount: account.counts.followers }),
    ...(account.counts?.following === undefined
      ? {}
      : { followingCount: account.counts.following }),
    ...(account.counts?.posts === undefined ? {} : { postsCount: account.counts.posts }),
    extensions: {},
    raw: account.raw,
  };
}

export function serializeInstanceProfile(profile: InstanceProfile): PublicInstanceProfile {
  return {
    ref: serializeEntityRef(profile.ref),
    software: profile.software,
    ...(profile.title === undefined ? {} : { title: profile.title }),
    ...(profile.description === undefined ? {} : { description: profile.description }),
    languages: profile.languages,
    ...(profile.registrations === undefined ? {} : { registrations: profile.registrations }),
    capabilities: serializeCapabilitySetPayload(profile.capabilities),
    raw: profile.raw,
  };
}

export function serializePost(post: Post): PublicPost {
  return {
    ref: serializeEntityRef(post.ref),
    author: serializeEntityRef(post.author),
    ...(post.url === undefined ? {} : { url: post.url }),
    contentHtml: post.contentHtml,
    ...(post.contentText === undefined ? {} : { contentText: post.contentText }),
    createdAt: post.createdAt,
    visibility: post.visibility,
    sensitive: post.sensitive,
    ...(post.spoilerText === undefined ? {} : { spoilerText: post.spoilerText }),
    attachments: post.attachments,
    ...(post.poll === undefined ? {} : { poll: post.poll }),
    ...(post.replyTo === undefined ? {} : { replyTo: serializeEntityRef(post.replyTo) }),
    ...(post.quoteOf === undefined ? {} : { quoteOf: serializeEntityRef(post.quoteOf) }),
    ...(post.reblogOf === undefined ? {} : { reblogOf: serializeEntityRef(post.reblogOf) }),
    ...(post.counts === undefined ? {} : { counts: post.counts }),
    raw: post.raw,
  };
}

export function serializePostConnection(
  connection: Connection<Post>,
): PublicConnection<PublicPost> {
  return {
    nodes: connection.nodes.map((post) => serializePost(post)),
    pageInfo: connection.pageInfo,
  };
}

export function serializeAuthSession(session: AuthSession): PublicAuthSession {
  return {
    id: session.id,
    adapter: session.adapter,
    origin: session.origin,
    ...(session.account === undefined ? {} : { account: serializeEntityRef(session.account) }),
    scopes: session.scopes,
    capabilities: session.capabilities,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  };
}

export function serializeEntityRef(ref: EntityRef): PublicEntityRef {
  return {
    id: ref.id,
    type: ref.type,
    adapter: ref.adapter,
    origin: ref.origin,
    rawId: ref.rawId,
    ...(ref.rawUrl === undefined ? {} : { rawUrl: ref.rawUrl }),
  };
}

export function serializeAuthStart(result: AuthStartResult): AuthStartPayload {
  return {
    clientId: result.client.clientId,
    redirectUris: result.client.redirectUris,
    ...(result.client.scopes === undefined ? {} : { scopes: result.client.scopes }),
    authorizationUrl: result.authorization.url.href,
    state: result.authorization.state,
    ...(result.authorization.codeVerifier === undefined
      ? {}
      : { codeVerifier: result.authorization.codeVerifier }),
    ...(result.authorization.codeChallenge === undefined
      ? {}
      : { codeChallenge: result.authorization.codeChallenge }),
    ...(result.authorization.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: result.authorization.codeChallengeMethod }),
    ...("callbackBinding" in result &&
    typeof result.callbackBinding === "object" &&
    result.callbackBinding !== null
      ? { callbackBinding: result.callbackBinding as PublicOAuthCallbackStateBinding }
      : {}),
  };
}

export function serializeParsedAuthCallback(callback: OAuthCallbackResult): ParsedAuthCallback {
  if (callback.ok) {
    return {
      code: callback.code,
      state: callback.state,
    };
  }
  return {
    error: callback.error,
    ...(callback.errorDescription === undefined
      ? {}
      : { errorDescription: callback.errorDescription }),
    ...(callback.state === undefined ? {} : { state: callback.state }),
  };
}
