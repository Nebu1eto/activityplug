import {
  ActivityPlugError,
  capabilityNames,
  parseOAuthCallback,
  type AuthSession,
  type Account,
  type CapabilityDecision,
  type CapabilitySet,
  type EntityRef,
  type InjectTokenInput,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthCallbackStateBinding,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthRevokeInput,
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
  readonly auth: ActivityPlugAuthApiService;
  readonly viewer: (input: ViewerInput) => Promise<VerifyCredentialsResult>;
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

export interface AuthStartPayload {
  readonly clientId: string;
  readonly clientSecret?: string;
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
      Omit<OAuthCodeExchangeInput, "code" | "state"> & {
        readonly callback: OAuthCallbackInput;
        readonly expectedState: string;
        readonly expectedBinding: OAuthCallbackStateBinding;
        readonly actualBinding: OAuthCallbackStateBinding;
      })
  | (InstanceSelector & OAuthCodeExchangeInput);

export type AuthRefreshRequest = InstanceSelector & OAuthRefreshInput;

export type AuthRevokeRequest = InstanceSelector & OAuthRevokeInput;

export interface AuthSessionIdRequest {
  readonly sessionId: string;
}

export interface ViewerInput {
  readonly sessionId: string;
}

export function createDefaultApiService(capabilities: CapabilitySet): ActivityPlugApiService {
  const unsupportedAuth = async (): Promise<never> => {
    throw new ActivityPlugError("AUTH_UNSUPPORTED", "No ActivityPlug auth service is configured.");
  };
  return {
    health: () => ({ ok: true, version: activityPlugApiVersion }),
    capabilities: () => capabilities,
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
    ...(result.client.clientSecret === undefined
      ? {}
      : { clientSecret: result.client.clientSecret }),
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
