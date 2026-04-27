import { randomUUID } from "node:crypto";

import { ActivityPlugError, isActivityPlugError, maxPageLimit } from "@activityplug/core";
import SchemaBuilder from "@pothos/core";
import { GraphQLError } from "graphql";

import { serializeActivityPlugError } from "../api/errors.js";
import {
  activityPlugApiVersion,
  serializeAuthStart,
  serializeAuthSession,
  serializeCapabilitySetPayload,
  serializeParsedAuthCallback,
  type ActivityPlugApiService,
  type AuthExchangeRequest,
  type AuthStartRequest,
  type CapabilityListItem,
  type CapabilitySetPayload,
  type AuthStartPayload,
  type HealthStatus,
  type ImportTokenRequest,
  type ParsedAuthCallback,
  type PublicAccount,
  type PublicAccountField,
  type PublicAuthSession,
  type PublicEntityRef,
  type PublicInstanceProfile,
  type PublicPost,
  serializeAccount,
  serializeInstanceProfile,
  serializePostConnection,
} from "../api/service.js";
import { type TokenImportOptions } from "../http/app.js";

export interface GraphQLContext {
  readonly service: ActivityPlugApiService;
  readonly request: Request;
  readonly tokenImport?: TokenImportOptions;
}

type AdapterKind = "mastodon" | "misskey" | "pleroma" | "hollo" | "hackerspub";

const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  Enums: {
    AdapterKind: AdapterKind;
  };
  Objects: {
    Account: PublicAccount;
    AccountField: PublicAccountField;
    AuthSession: PublicAuthSession;
    AuthStartPayload: AuthStartPayload;
    Capability: CapabilityListItem;
    CapabilitySet: CapabilitySetPayload;
    OAuthCallbackStateBinding: import("../api/service.js").PublicOAuthCallbackStateBinding;
    EntityRef: PublicEntityRef;
    Health: HealthStatus;
    Instance: PublicInstanceProfile;
    ParsedAuthCallback: ParsedAuthCallback;
    Post: PublicPost;
  };
  Scalars: {
    JSON: {
      Input: unknown;
      Output: unknown;
    };
  };
  DefaultFieldNullability: false;
}>({
  defaultFieldNullability: false,
});

const AdapterKindEnum = builder.enumType("AdapterKind", {
  values: {
    MASTODON: { value: "mastodon" },
    MISSKEY: { value: "misskey" },
    PLEROMA: { value: "pleroma" },
    HOLLO: { value: "hollo" },
    HACKERSPUB: { value: "hackerspub" },
  } as const,
});

const CodeChallengeMethodEnum = builder.enumType("CodeChallengeMethod", {
  values: {
    S256: { value: "S256" },
    PLAIN: { value: "plain" },
  } as const,
});

const JsonScalar = builder.scalarType("JSON", {
  serialize: (value) => value,
});

interface ReservedEntity {
  readonly id: string;
  readonly raw: unknown;
}

interface PageInfoPayload {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor?: string;
  readonly endCursor?: string;
  readonly raw?: unknown;
  readonly rawNext?: string;
  readonly rawPrevious?: string;
}

interface AccountConnectionPayload {
  readonly nodes: readonly PublicAccount[];
  readonly pageInfo: PageInfoPayload;
}

interface ReservedConnectionPayload {
  readonly nodes: readonly ReservedEntity[];
  readonly pageInfo: PageInfoPayload;
}

const OAuthClientInput = builder.inputType("OAuthClientInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    redirectUri: t.string({ required: true }),
    scopes: t.stringList({ required: false }),
    website: t.string({ required: false }),
  }),
});

const OAuthRegisteredClientInput = builder.inputType("OAuthRegisteredClientInput", {
  fields: (t) => ({
    clientId: t.string({ required: true }),
    clientSecret: t.string({ required: false }),
    redirectUris: t.stringList({ required: true }),
    scopes: t.stringList({ required: false }),
  }),
});

const TokenSetInput = builder.inputType("TokenSetInput", {
  fields: (t) => ({
    accessToken: t.string({ required: true }),
    tokenType: t.string({ required: false }),
    refreshToken: t.string({ required: false }),
    expiresAt: t.string({ required: false }),
    scopes: t.stringList({ required: false }),
  }),
});

const ImportTokenInput = builder.inputType("ImportTokenInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    token: t.field({ type: TokenSetInput, required: true }),
  }),
});

const AuthStartInput = builder.inputType("AuthStartInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    client: t.field({ type: OAuthClientInput, required: true }),
    redirectUri: t.string({ required: false }),
    state: t.string({ required: false }),
    scopes: t.stringList({ required: false }),
    codeChallenge: t.string({ required: false }),
    codeChallengeMethod: t.field({ type: CodeChallengeMethodEnum, required: false }),
  }),
});

const AuthCallbackParamsInput = builder.inputType("AuthCallbackParamsInput", {
  fields: (t) => ({
    code: t.string({ required: false }),
    state: t.string({ required: false }),
    error: t.string({ required: false }),
    errorDescription: t.string({ required: false }),
  }),
});

const AuthCallbackInput = builder.inputType("AuthCallbackInput", {
  fields: (t) => ({
    url: t.string({ required: false }),
    params: t.field({ type: AuthCallbackParamsInput, required: false }),
  }),
});

const OAuthCallbackStateBindingInput = builder.inputType("OAuthCallbackStateBindingInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    clientRequestId: t.string({ required: true }),
  }),
});

const AuthExchangeInput = builder.inputType("AuthExchangeInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    client: t.field({ type: OAuthRegisteredClientInput, required: false }),
    code: t.string({ required: false }),
    callback: t.field({ type: AuthCallbackInput, required: false }),
    expectedState: t.string({ required: false }),
    expectedBinding: t.field({ type: OAuthCallbackStateBindingInput, required: false }),
    actualBinding: t.field({ type: OAuthCallbackStateBindingInput, required: false }),
    redirectUri: t.string({ required: true }),
    codeVerifier: t.string({ required: false }),
    state: t.string({ required: false }),
  }),
});

const PageInput = builder.inputType("PageInput", {
  fields: (t) => ({
    after: t.string({ required: false }),
    before: t.string({ required: false }),
    limit: t.int({ required: false }),
  }),
});

const DetectInstanceInput = builder.inputType("DetectInstanceInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
  }),
});

const JsonInput = builder.inputType("OperationInput", {
  fields: (t) => ({
    id: t.id({ required: false }),
    origin: t.string({ required: false }),
    sessionId: t.id({ required: false }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
  }),
});

const Capability = builder.objectRef<CapabilityListItem>("Capability").implement({
  fields: (t) => ({
    name: t.exposeString("name"),
    status: t.exposeString("status"),
    source: t.exposeString("source"),
    reason: t.exposeString("reason", { nullable: true }),
  }),
});

const CapabilitySet = builder.objectRef<CapabilitySetPayload>("CapabilitySet").implement({
  fields: (t) => ({
    auth: t.expose("auth", { type: [Capability] }),
    instance: t.expose("instance", { type: [Capability] }),
    accounts: t.expose("accounts", { type: [Capability] }),
    posts: t.expose("posts", { type: [Capability] }),
    timelines: t.expose("timelines", { type: [Capability] }),
    media: t.expose("media", { type: [Capability] }),
    social: t.expose("social", { type: [Capability] }),
    search: t.expose("search", { type: [Capability] }),
    notifications: t.expose("notifications", { type: [Capability] }),
    polls: t.expose("polls", { type: [Capability] }),
    lists: t.expose("lists", { type: [Capability] }),
    streaming: t.expose("streaming", { type: [Capability] }),
    admin: t.expose("admin", { type: [Capability] }),
  }),
});

const Health = builder.objectRef<HealthStatus>("Health").implement({
  fields: (t) => ({
    ok: t.exposeBoolean("ok"),
    version: t.exposeString("version"),
  }),
});

const EntityRefType = builder.objectRef<PublicEntityRef>("EntityRef").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    type: t.exposeString("type"),
    adapter: t.field({
      type: AdapterKindEnum,
      resolve: (ref) => adapterKindValue(ref.adapter),
    }),
    origin: t.exposeString("origin"),
    rawId: t.exposeString("rawId"),
    rawUrl: t.exposeString("rawUrl", { nullable: true }),
  }),
});

const AuthSessionType = builder.objectRef<PublicAuthSession>("AuthSession").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    adapter: t.field({
      type: AdapterKindEnum,
      resolve: (session) => adapterKindValue(session.adapter),
    }),
    origin: t.exposeString("origin"),
    account: t.expose("account", { type: EntityRefType, nullable: true }),
    scopes: t.exposeStringList("scopes"),
    capabilities: t.field({
      type: JsonScalar,
      resolve: (session) => session.capabilities,
    }),
    expiresAt: t.exposeString("expiresAt", { nullable: true }),
  }),
});

const AuthStartPayloadType = builder.objectRef<AuthStartPayload>("AuthStartPayload").implement({
  fields: (t) => ({
    clientId: t.exposeString("clientId"),
    redirectUris: t.exposeStringList("redirectUris"),
    scopes: t.exposeStringList("scopes", { nullable: true }),
    authorizationUrl: t.exposeString("authorizationUrl"),
    state: t.exposeString("state"),
    codeVerifier: t.exposeString("codeVerifier", { nullable: true }),
    codeChallenge: t.exposeString("codeChallenge", { nullable: true }),
    codeChallengeMethod: t.exposeString("codeChallengeMethod", { nullable: true }),
    callbackBinding: t.expose("callbackBinding", {
      type: builder
        .objectRef<import("../api/service.js").PublicOAuthCallbackStateBinding>(
          "OAuthCallbackStateBinding",
        )
        .implement({
          fields: (binding) => ({
            adapter: binding.field({
              type: AdapterKindEnum,
              resolve: (value) => adapterKindValue(value.adapter),
            }),
            origin: binding.exposeString("origin"),
            clientRequestId: binding.exposeString("clientRequestId"),
          }),
        }),
      nullable: true,
    }),
  }),
});

const AccountType = builder.objectRef<PublicAccount>("Account").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    username: t.exposeString("username"),
    handle: t.exposeString("handle"),
    displayName: t.exposeString("displayName"),
    url: t.exposeString("url", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    headerUrl: t.exposeString("headerUrl", { nullable: true }),
    fields: t.field({
      type: [
        builder.objectRef<PublicAccountField>("AccountField").implement({
          fields: (field) => ({
            name: field.exposeString("name"),
            valueHtml: field.exposeString("valueHtml"),
            verifiedAt: field.exposeString("verifiedAt", { nullable: true }),
          }),
        }),
      ],
      resolve: (account) => account.fields,
    }),
    bot: t.exposeBoolean("bot"),
    locked: t.exposeBoolean("locked"),
    createdAt: t.exposeString("createdAt", { nullable: true }),
    bioHtml: t.exposeString("bioHtml", { nullable: true }),
    followersCount: t.exposeInt("followersCount", { nullable: true }),
    followingCount: t.exposeInt("followingCount", { nullable: true }),
    postsCount: t.exposeInt("postsCount", { nullable: true }),
    extensions: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (account) => account.extensions,
    }),
    raw: t.field({
      type: JsonScalar,
      resolve: (account) => account.raw,
    }),
  }),
});

const ParsedAuthCallbackType = builder
  .objectRef<ParsedAuthCallback>("ParsedAuthCallback")
  .implement({
    fields: (t) => ({
      code: t.exposeString("code", { nullable: true }),
      state: t.exposeString("state", { nullable: true }),
      error: t.exposeString("error", { nullable: true }),
      errorDescription: t.exposeString("errorDescription", { nullable: true }),
    }),
  });

const InstanceType = builder.objectRef<PublicInstanceProfile>("Instance").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    software: t.field({
      type: JsonScalar,
      resolve: (instance) => instance.software,
    }),
    title: t.exposeString("title", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    languages: t.exposeStringList("languages"),
    registrations: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (instance) => instance.registrations,
    }),
    capabilities: t.expose("capabilities", { type: CapabilitySet }),
    raw: t.field({
      type: JsonScalar,
      resolve: (instance) => instance.raw,
    }),
  }),
});

const PageInfoType = builder.objectRef<PageInfoPayload>("PageInfo").implement({
  fields: (t) => ({
    hasNextPage: t.exposeBoolean("hasNextPage"),
    hasPreviousPage: t.exposeBoolean("hasPreviousPage"),
    startCursor: t.exposeString("startCursor", { nullable: true }),
    endCursor: t.exposeString("endCursor", { nullable: true }),
    raw: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (value) => value.raw,
    }),
    rawNext: t.exposeString("rawNext", { nullable: true }),
    rawPrevious: t.exposeString("rawPrevious", { nullable: true }),
  }),
});

function reservedObjectType(name: string) {
  return builder.objectRef<ReservedEntity>(name).implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      raw: t.field({
        type: JsonScalar,
        resolve: (value) => value.raw,
      }),
    }),
  });
}

const PostType = builder.objectRef<PublicPost>("Post").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    author: t.expose("author", { type: EntityRefType }),
    url: t.exposeString("url", { nullable: true }),
    contentHtml: t.exposeString("contentHtml"),
    contentText: t.exposeString("contentText", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
    visibility: t.exposeString("visibility"),
    sensitive: t.exposeBoolean("sensitive"),
    spoilerText: t.exposeString("spoilerText", { nullable: true }),
    attachments: t.field({
      type: [JsonScalar],
      resolve: (post) => post.attachments,
    }),
    poll: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (post) => post.poll,
    }),
    replyTo: t.expose("replyTo", { type: EntityRefType, nullable: true }),
    quoteOf: t.expose("quoteOf", { type: EntityRefType, nullable: true }),
    reblogOf: t.expose("reblogOf", { type: EntityRefType, nullable: true }),
    counts: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (post) => post.counts,
    }),
    raw: t.field({
      type: JsonScalar,
      resolve: (post) => post.raw,
    }),
  }),
});
const PostContextType = reservedObjectType("PostContext");
const MediaAttachmentType = reservedObjectType("MediaAttachment");
const PollType = reservedObjectType("Poll");
const NotificationType = reservedObjectType("Notification");
const ListType = reservedObjectType("List");
const RelationshipType = reservedObjectType("Relationship");
const SearchResultType = reservedObjectType("SearchResult");
const DeletedEntityType = reservedObjectType("DeletedEntity");

const AccountConnectionType = builder
  .objectRef<AccountConnectionPayload>("AccountConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({
        type: [AccountType],
        resolve: (value) => value.nodes,
      }),
      pageInfo: t.field({
        type: PageInfoType,
        resolve: (value) => value.pageInfo,
      }),
    }),
  });

function reservedConnectionType(name: string, nodeType: unknown) {
  return builder.objectRef<ReservedConnectionPayload>(name).implement({
    fields: (t) => ({
      nodes: t.field({
        type: [nodeType] as never,
        resolve: (value) => value.nodes,
      }),
      pageInfo: t.field({
        type: PageInfoType,
        resolve: (value) => value.pageInfo,
      }),
    }),
  });
}

const PostConnectionType = reservedConnectionType("PostConnection", PostType);
const TimelineConnectionType = reservedConnectionType("TimelineConnection", PostType);
const NotificationConnectionType = reservedConnectionType(
  "NotificationConnection",
  NotificationType,
);
const ListConnectionType = reservedConnectionType("ListConnection", ListType);

builder.queryType({
  fields: (t) => ({
    apiVersion: t.string({
      resolve: () => activityPlugApiVersion,
    }),
    health: t.field({
      type: Health,
      resolve: async (_parent, _args, context) =>
        withGraphQLErrorContract(() => context.service.health()),
    }),
    capabilities: t.field({
      args: {
        adapter: t.arg({ type: AdapterKindEnum, required: false }),
        origin: t.arg.string({ required: true }),
      },
      type: CapabilitySet,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeCapabilitySetPayload(
            await context.service.capabilities({
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
              origin: args.origin,
            }),
          ),
        ),
    }),
    viewer: t.field({
      args: {
        sessionId: t.arg.id({ required: true }),
      },
      type: AccountType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAccount((await context.service.viewer({ sessionId: args.sessionId })).account),
        ),
    }),
    instance: unsupportedGraphQLField(t, {
      type: InstanceType,
      operation: "instance.get",
      args: { origin: t.arg.string({ required: true }), adapter: t.arg({ type: AdapterKindEnum }) },
      resolve: async (
        _parent: unknown,
        args: { readonly origin: string; readonly adapter?: AdapterKind | null },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeInstanceProfile(
            await context.service.instances.get({
              origin: args.origin,
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
            }),
          ),
        ),
    }),
    detectInstance: unsupportedGraphQLField(t, {
      type: InstanceType,
      operation: "instance.detect",
      args: { input: t.arg({ type: DetectInstanceInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: {
          readonly input: { readonly origin: string; readonly adapter?: AdapterKind | null };
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeInstanceProfile(
            await context.service.instances.detect({
              origin: args.input.origin,
              ...(args.input.adapter === null || args.input.adapter === undefined
                ? {}
                : { adapter: args.input.adapter }),
            }),
          ),
        ),
    }),
    account: unsupportedGraphQLField(t, {
      type: AccountType,
      operation: "account.get",
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_parent: unknown, args: { readonly id: string }, context: GraphQLContext) =>
        withGraphQLErrorContract(async () =>
          serializeAccount(await context.service.accounts.get({ id: args.id })),
        ),
    }),
    accountByHandle: unsupportedGraphQLField(t, {
      type: AccountType,
      nullable: true,
      operation: "account.lookup",
      args: {
        origin: t.arg.string({ required: true }),
        handle: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterKindEnum }),
      },
      resolve: async (
        _parent: unknown,
        args: {
          readonly origin: string;
          readonly handle: string;
          readonly adapter?: AdapterKind | null;
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () => {
          const account = await context.service.accounts.lookup({
            origin: args.origin,
            handle: args.handle,
            ...(args.adapter === null || args.adapter === undefined
              ? {}
              : { adapter: args.adapter }),
          });
          return account === null ? null : serializeAccount(account);
        }),
    }),
    accountPosts: unsupportedGraphQLField(t, {
      type: PostConnectionType,
      operation: "account.posts",
      args: { id: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
      resolve: async (
        _parent: unknown,
        args: {
          readonly id: string;
          readonly page?: {
            readonly after?: string | null;
            readonly before?: string | null;
            readonly limit?: number | null;
          } | null;
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePostConnection(
            await context.service.accounts.posts({
              id: args.id,
              page: normalizePageInput(args.page),
            }),
          ),
        ),
    }),
    post: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "post.get",
      args: { id: t.arg.id({ required: true }) },
    }),
    postContext: unsupportedGraphQLField(t, {
      type: PostContextType,
      operation: "post.context",
      args: { id: t.arg.id({ required: true }) },
    }),
    postQuotes: unsupportedGraphQLField(t, {
      type: PostConnectionType,
      operation: "post.quotes",
      args: { id: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
    }),
    homeTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.home",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
    }),
    publicTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.public",
      args: {
        origin: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterKindEnum }),
        local: t.arg.boolean(),
        page: t.arg({ type: PageInput }),
      },
    }),
    hashtagTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.hashtag",
      args: {
        origin: t.arg.string({ required: true }),
        tag: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterKindEnum }),
        page: t.arg({ type: PageInput }),
      },
    }),
    listTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.list",
      args: { listId: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
    }),
    search: unsupportedGraphQLField(t, {
      type: SearchResultType,
      operation: "search",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    notifications: unsupportedGraphQLField(t, {
      type: NotificationConnectionType,
      operation: "notification.list",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
    }),
    notificationUnreadCount: t.int({
      args: { origin: t.arg.string({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: unsupportedGraphQLResolver("notification.unreadCount"),
    }),
    followRequests: unsupportedGraphQLField(t, {
      type: AccountConnectionType,
      operation: "followRequest.list",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
    }),
    poll: unsupportedGraphQLField(t, {
      type: PollType,
      operation: "poll.get",
      args: { id: t.arg.id({ required: true }) },
    }),
    lists: unsupportedGraphQLField(t, {
      type: ListConnectionType,
      operation: "list.list",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
    }),
    list: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.get",
      args: { id: t.arg.id({ required: true }) },
    }),
    listAccounts: unsupportedGraphQLField(t, {
      type: AccountConnectionType,
      operation: "list.accounts",
      args: { id: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    importToken: t.field({
      args: {
        input: t.arg({ type: ImportTokenInput, required: true }),
      },
      type: AuthSessionType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () => {
          await enforceTokenImportPolicy(context);
          return serializeAuthSession(
            await context.service.auth.importToken(normalizeImportToken(args.input)),
          );
        }),
    }),
    authStart: t.field({
      args: {
        input: t.arg({ type: AuthStartInput, required: true }),
      },
      type: AuthStartPayloadType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAuthStart(await context.service.auth.start(normalizeAuthStart(args.input))),
        ),
    }),
    authParseCallback: t.field({
      args: {
        input: t.arg({ type: AuthCallbackInput, required: true }),
      },
      type: ParsedAuthCallbackType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(() =>
          serializeParsedAuthCallback(
            context.service.auth.parseCallback(normalizeCallbackInput(args.input)),
          ),
        ),
    }),
    authExchange: t.field({
      args: {
        input: t.arg({ type: AuthExchangeInput, required: true }),
      },
      type: AuthSessionType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAuthSession(
            await context.service.auth.exchange(normalizeAuthExchange(args.input)),
          ),
        ),
    }),
    authRefresh: t.field({
      args: {
        sessionId: t.arg.id({ required: true }),
      },
      type: AuthSessionType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAuthSession(
            await context.service.auth.refreshSession({ sessionId: args.sessionId }),
          ),
        ),
    }),
    authRevoke: t.boolean({
      args: {
        sessionId: t.arg.id({ required: true }),
      },
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () => {
          await context.service.auth.revokeSession({ sessionId: args.sessionId });
          return true;
        }),
    }),
    uploadMedia: unsupportedGraphQLField(t, {
      type: MediaAttachmentType,
      operation: "media.upload",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    ingestMediaFromUrl: unsupportedGraphQLField(t, {
      type: MediaAttachmentType,
      operation: "media.ingestUrl",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    createPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "post.create",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    updatePost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "post.update",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    deletePost: unsupportedGraphQLField(t, {
      type: DeletedEntityType,
      operation: "post.delete",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    followAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.follow",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    unfollowAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.unfollow",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    blockAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.block",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    unblockAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.unblock",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    muteAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.mute",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    unmuteAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.unmute",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    favouritePost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.favourite",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    unfavouritePost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unfavourite",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    bookmarkPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.bookmark",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    unbookmarkPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unbookmark",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    boostPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.boost",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    unboostPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unboost",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    reactToPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.reaction",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    unreactToPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unreaction",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    votePoll: unsupportedGraphQLField(t, {
      type: PollType,
      operation: "poll.vote",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    acceptFollowRequest: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "followRequest.accept",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    rejectFollowRequest: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "followRequest.reject",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    createList: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.create",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    updateList: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.update",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    deleteList: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.delete",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    addListAccount: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.account.add",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    removeListAccount: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.account.remove",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    dismissNotification: t.boolean({
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: unsupportedGraphQLResolver("notification.dismiss"),
    }),
    clearNotifications: t.boolean({
      args: { origin: t.arg.string({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: unsupportedGraphQLResolver("notification.clear"),
    }),
  }),
});

export function createGraphQLSchema() {
  return builder.toSchema();
}

function unsupportedGraphQLField(
  t: unknown,
  options: {
    readonly type: unknown;
    readonly operation: string;
    readonly args?: Record<string, unknown>;
    readonly nullable?: boolean;
    readonly resolve?: (...args: never[]) => unknown;
  },
): never {
  return (t as { field: (options: object) => unknown }).field({
    type: options.type,
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.nullable === undefined ? {} : { nullable: options.nullable }),
    resolve: options.resolve ?? unsupportedGraphQLResolver(options.operation),
  }) as never;
}

function unsupportedGraphQLResolver(operation: string): () => Promise<never> {
  return async () =>
    withGraphQLErrorContract(() => {
      throw new ActivityPlugError(
        "UNSUPPORTED_OPERATION",
        "This GraphQL operation is reserved but not implemented yet.",
        { operation },
      );
    });
}

async function withGraphQLErrorContract<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const activityPlugError = isActivityPlugError(error)
      ? error
      : new ActivityPlugError("INTERNAL_ERROR", "An internal server error occurred.");
    throw new GraphQLError(activityPlugError.message, {
      extensions: {
        activityplug: serializeActivityPlugError(activityPlugError),
      },
    });
  }
}

async function enforceTokenImportPolicy(context: GraphQLContext): Promise<void> {
  if (context.tokenImport?.enabled !== true) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Token import is disabled for this server.",
      { operation: "auth.tokenInjection" },
    );
  }
  await context.tokenImport?.guard?.({
    transport: "graphql",
    request: context.request,
  });
}

function normalizeImportToken(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly token: {
    readonly accessToken: string;
    readonly tokenType?: string | null;
    readonly refreshToken?: string | null;
    readonly expiresAt?: string | null;
    readonly scopes?: readonly string[] | null;
  };
}): ImportTokenRequest {
  return {
    adapter: input.adapter,
    origin: input.origin,
    accessToken: input.token.accessToken,
    ...(input.token.tokenType === null || input.token.tokenType === undefined
      ? {}
      : { tokenType: input.token.tokenType }),
    ...(input.token.refreshToken === null || input.token.refreshToken === undefined
      ? {}
      : { refreshToken: input.token.refreshToken }),
    ...(input.token.expiresAt === null || input.token.expiresAt === undefined
      ? {}
      : { expiresAt: input.token.expiresAt }),
    ...(input.token.scopes === null || input.token.scopes === undefined
      ? {}
      : { scopes: input.token.scopes }),
  };
}

function normalizePageInput(
  input:
    | {
        readonly after?: string | null;
        readonly before?: string | null;
        readonly limit?: number | null;
      }
    | null
    | undefined,
): { readonly after?: string; readonly before?: string; readonly limit?: number } | undefined {
  if (input === null || input === undefined) return undefined;
  if (
    input.limit !== null &&
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > maxPageLimit)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL page input field must be an integer between 1 and ${maxPageLimit}: limit.`,
    );
  }
  if (input.after !== null && input.after !== undefined && input.after.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL page input field must be a non-empty string: after.",
    );
  }
  if (input.before !== null && input.before !== undefined && input.before.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL page input field must be a non-empty string: before.",
    );
  }
  return {
    ...(input.after === null || input.after === undefined ? {} : { after: input.after }),
    ...(input.before === null || input.before === undefined ? {} : { before: input.before }),
    ...(input.limit === null || input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function normalizeAuthStart(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly client: {
    readonly name: string;
    readonly redirectUri: string;
    readonly scopes?: readonly string[] | null;
    readonly website?: string | null;
  };
  readonly redirectUri?: string | null;
  readonly state?: string | null;
  readonly scopes?: readonly string[] | null;
  readonly codeChallenge?: string | null;
  readonly codeChallengeMethod?: "S256" | "plain" | null;
}): AuthStartRequest {
  return {
    adapter: input.adapter,
    origin: input.origin,
    client: {
      clientName: input.client.name,
      redirectUris: [input.client.redirectUri],
      ...(input.client.scopes === null || input.client.scopes === undefined
        ? {}
        : { scopes: input.client.scopes }),
      ...(input.client.website === null || input.client.website === undefined
        ? {}
        : { website: input.client.website }),
    },
    redirectUri: input.redirectUri ?? input.client.redirectUri,
    state: input.state ?? randomUUID(),
    ...(input.scopes === null || input.scopes === undefined
      ? input.client.scopes === null || input.client.scopes === undefined
        ? {}
        : { scopes: input.client.scopes }
      : { scopes: input.scopes }),
    ...(input.codeChallenge === null || input.codeChallenge === undefined
      ? {}
      : { codeChallenge: input.codeChallenge }),
    ...(input.codeChallengeMethod === null || input.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: input.codeChallengeMethod }),
  };
}

function normalizeAuthExchange(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly client?: {
    readonly clientId: string;
    readonly clientSecret?: string | null;
    readonly redirectUris: readonly string[];
    readonly scopes?: readonly string[] | null;
  } | null;
  readonly code?: string | null;
  readonly callback?: {
    readonly url?: string | null;
    readonly params?: {
      readonly code?: string | null;
      readonly state?: string | null;
      readonly error?: string | null;
      readonly errorDescription?: string | null;
    } | null;
  } | null;
  readonly expectedState?: string | null;
  readonly expectedBinding?: {
    readonly adapter: string;
    readonly origin: string;
    readonly clientRequestId: string;
  } | null;
  readonly actualBinding?: {
    readonly adapter: string;
    readonly origin: string;
    readonly clientRequestId: string;
  } | null;
  readonly redirectUri: string;
  readonly codeVerifier?: string | null;
  readonly state?: string | null;
}): AuthExchangeRequest {
  const shared = {
    adapter: input.adapter,
    origin: input.origin,
    redirectUri: input.redirectUri,
    ...(input.codeVerifier === null || input.codeVerifier === undefined
      ? {}
      : { codeVerifier: input.codeVerifier }),
  };
  if (input.callback !== null && input.callback !== undefined) {
    if (input.expectedState === null || input.expectedState === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires expectedState.",
      );
    }
    if (input.expectedBinding === null || input.expectedBinding === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires expectedBinding.",
      );
    }
    if (input.actualBinding === null || input.actualBinding === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires actualBinding.",
      );
    }
    return {
      ...shared,
      callback: normalizeCallbackInput(input.callback),
      expectedState: input.expectedState,
      expectedBinding: input.expectedBinding,
      actualBinding: input.actualBinding,
    };
  }
  if (
    (input.expectedState !== null && input.expectedState !== undefined) ||
    (input.expectedBinding !== null && input.expectedBinding !== undefined) ||
    (input.actualBinding !== null && input.actualBinding !== undefined)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "OAuth callback validation fields require callback exchange.",
    );
  }
  if (input.code === null || input.code === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth code exchange requires code.");
  }
  if (input.state === null || input.state === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth code exchange requires state.");
  }
  return {
    ...shared,
    ...(input.client === null || input.client === undefined
      ? {}
      : {
          client: {
            clientId: input.client.clientId,
            ...(input.client.clientSecret === null || input.client.clientSecret === undefined
              ? {}
              : { clientSecret: input.client.clientSecret }),
            redirectUris: input.client.redirectUris,
            ...(input.client.scopes === null || input.client.scopes === undefined
              ? {}
              : { scopes: input.client.scopes }),
          },
        }),
    code: input.code,
    state: input.state,
  };
}

function normalizeCallbackInput(input: {
  readonly url?: string | null;
  readonly params?: {
    readonly code?: string | null;
    readonly state?: string | null;
    readonly error?: string | null;
    readonly errorDescription?: string | null;
  } | null;
}) {
  const params = input.params;
  return {
    ...(input.url === null || input.url === undefined ? {} : { url: input.url }),
    params: {
      ...(params?.code === null || params?.code === undefined ? {} : { code: params.code }),
      ...(params?.state === null || params?.state === undefined ? {} : { state: params.state }),
      ...(params?.error === null || params?.error === undefined ? {} : { error: params.error }),
      ...(params?.errorDescription === null || params?.errorDescription === undefined
        ? {}
        : { errorDescription: params.errorDescription }),
    },
  };
}

function adapterKindValue(adapter: string): AdapterKind {
  switch (adapter) {
    case "mastodon":
    case "misskey":
    case "pleroma":
    case "hollo":
    case "hackerspub":
      return adapter;
    default:
      throw new ActivityPlugError("VALIDATION_FAILED", `Unknown GraphQL adapter kind: ${adapter}.`);
  }
}
