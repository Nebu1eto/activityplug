import {
  type serializeAccountConnection,
  type serializeAccount,
  type serializeAuthSession,
  type serializeAuthStart,
  type serializeCapabilitySetPayload,
  type serializeDeletedEntity,
  type serializeFilter,
  type serializeFilterConnection,
  type serializeInstanceProfile,
  type serializeMediaAttachment,
  type serializeList,
  type serializeListConnection,
  type serializeNotificationConnection,
  type serializeParsedAuthCallback,
  type serializePoll,
  type serializePost,
  type serializePostConnection,
  type serializePostRevision,
  type serializeRelationship,
  type serializeScheduledPost,
  type serializeScheduledPostConnection,
  type serializeSearchResult,
} from "../api/service.js";
import { bearerSessionId, optionalBearerSessionId } from "../http/app-helpers.js";
import {
  deleteMediaInput,
  filterInput,
  listAccountInput,
  listInput,
  notificationTypeInput,
  postUpdateInput,
  schedulePostInput,
  updateMediaInput,
  updateFilterInput,
  updateListInput,
  updateProfileInput,
  updateScheduledPostInput,
  uploadMediaFromUrlInput,
} from "./schema-inputs.js";
import {
  type accountActionResolver,
  type normalizeAuthExchange,
  type normalizeAuthStart,
  type normalizeEmailChallengeStart,
  type normalizeEmailChallengeVerify,
  type normalizeBoostInput,
  type normalizeCallbackInput,
  type normalizeCreatePostInput,
  type normalizeImportToken,
  type normalizeMuteInput,
  type normalizePasskeyFinish,
  type normalizePasskeyStart,
  type normalizePageInput,
  type normalizeReactInput,
  type normalizeSearchInput,
  type normalizeUploadMediaInput,
  type normalizeVotePollInput,
  type postActionResolver,
  type unsupportedGraphQLField,
  type unsupportedGraphQLResolver,
  type withGraphQLErrorContract,
} from "./schema-normalization.js";
import { type AdapterKind, type GraphQLContext, type PageInputValue } from "./schema.js";

type Resolver = (...args: any[]) => unknown;
type FieldOptions = {
  readonly args?: Record<string, unknown>;
  readonly nullable?: boolean;
  readonly operation?: string;
  readonly required?: boolean;
  readonly resolve?: Resolver;
  readonly type?: unknown;
};
type ArgBuilder = ((options: FieldOptions) => unknown) & {
  readonly boolean: (options?: FieldOptions) => unknown;
  readonly field: (options: FieldOptions) => unknown;
  readonly id: (options?: FieldOptions) => unknown;
  readonly string: (options?: FieldOptions) => unknown;
  readonly stringList: (options?: FieldOptions) => unknown;
};
type FieldBuilder = {
  readonly arg: ArgBuilder;
  readonly boolean: (options: FieldOptions) => unknown;
  readonly field: (options: FieldOptions) => unknown;
  readonly int: (options: FieldOptions) => unknown;
  readonly string: (options: FieldOptions) => unknown;
};
export type BuilderLike = {
  readonly mutationType: (options: { readonly fields: (t: FieldBuilder) => unknown }) => void;
  readonly queryType: (options: { readonly fields: (t: FieldBuilder) => unknown }) => void;
};
type SchemaOperationDeps = {
  readonly AccountConnectionType: unknown;
  readonly AccountType: unknown;
  readonly AuthCallbackInput: unknown;
  readonly AuthExchangeInput: unknown;
  readonly AuthSessionType: unknown;
  readonly AuthStartInput: unknown;
  readonly AuthStartPayloadType: unknown;
  readonly EmailChallengeStartInput: unknown;
  readonly EmailChallengeStartPayloadType: unknown;
  readonly EmailChallengeVerifyInput: unknown;
  readonly BoostPostInput: unknown;
  readonly CapabilitySet: unknown;
  readonly CreateFilterInput: unknown;
  readonly CreateListInput: unknown;
  readonly CreatePostInput: unknown;
  readonly DeletedEntityType: unknown;
  readonly DetectInstanceInput: unknown;
  readonly DeleteMediaInput: unknown;
  readonly FilterConnectionType: unknown;
  readonly FilterType: unknown;
  readonly Health: unknown;
  readonly InstanceType: unknown;
  readonly ListConnectionType: unknown;
  readonly ListAccountInput: unknown;
  readonly ListType: unknown;
  readonly MediaAttachmentType: unknown;
  readonly MuteAccountInput: unknown;
  readonly NotificationConnectionType: unknown;
  readonly NotificationTypeInputEnum: unknown;
  readonly PageInput: unknown;
  readonly PasskeyFinishInput: unknown;
  readonly PasskeyStartInput: unknown;
  readonly PasskeyStartPayloadType: unknown;
  readonly ParsedAuthCallbackType: unknown;
  readonly PollType: unknown;
  readonly PostConnectionType: unknown;
  readonly PostRevisionType: unknown;
  readonly PostType: unknown;
  readonly ReactPostInput: unknown;
  readonly RelationshipType: unknown;
  readonly SearchInput: unknown;
  readonly SearchResultType: unknown;
  readonly SchedulePostInput: unknown;
  readonly ScheduledPostConnectionType: unknown;
  readonly ScheduledPostType: unknown;
  readonly TimelineConnectionType: unknown;
  readonly UpdateFilterInput: unknown;
  readonly UpdateListInput: unknown;
  readonly UpdateMediaInput: unknown;
  readonly UpdatePostInput: unknown;
  readonly UpdateProfileInput: unknown;
  readonly UpdateScheduledPostInput: unknown;
  readonly UploadMediaFromUrlInput: unknown;
  readonly UploadMediaInput: unknown;
  readonly VotePollInput: unknown;
  readonly activityPlugApiVersion: string;
  readonly AdapterIdScalar: unknown;
  readonly ImportTokenInput: unknown;
  readonly enforceTokenImportPolicy: (context: GraphQLContext) => Promise<void>;
  readonly nonBlankString: (value: string, field: string) => string;
  readonly normalizeAuthExchange: typeof normalizeAuthExchange;
  readonly normalizeAuthStart: typeof normalizeAuthStart;
  readonly normalizeEmailChallengeStart: typeof normalizeEmailChallengeStart;
  readonly normalizeEmailChallengeVerify: typeof normalizeEmailChallengeVerify;
  readonly normalizeBoostInput: typeof normalizeBoostInput;
  readonly normalizeCallbackInput: typeof normalizeCallbackInput;
  readonly normalizeCreatePostInput: typeof normalizeCreatePostInput;
  readonly normalizeImportToken: typeof normalizeImportToken;
  readonly normalizeMuteInput: typeof normalizeMuteInput;
  readonly normalizePasskeyFinish: typeof normalizePasskeyFinish;
  readonly normalizePasskeyStart: typeof normalizePasskeyStart;
  readonly normalizePageInput: typeof normalizePageInput;
  readonly normalizeReactInput: typeof normalizeReactInput;
  readonly normalizeSearchInput: typeof normalizeSearchInput;
  readonly normalizeUploadMediaInput: typeof normalizeUploadMediaInput;
  readonly normalizeVotePollInput: typeof normalizeVotePollInput;
  readonly serializeAccount: typeof serializeAccount;
  readonly serializeAccountConnection: typeof serializeAccountConnection;
  readonly serializeAuthSession: typeof serializeAuthSession;
  readonly serializeAuthStart: typeof serializeAuthStart;
  readonly serializeCapabilitySetPayload: typeof serializeCapabilitySetPayload;
  readonly serializeDeletedEntity: typeof serializeDeletedEntity;
  readonly serializeFilter: typeof serializeFilter;
  readonly serializeFilterConnection: typeof serializeFilterConnection;
  readonly serializeInstanceProfile: typeof serializeInstanceProfile;
  readonly serializeMediaAttachment: typeof serializeMediaAttachment;
  readonly serializeList: typeof serializeList;
  readonly serializeListConnection: typeof serializeListConnection;
  readonly serializeNotificationConnection: typeof serializeNotificationConnection;
  readonly serializeParsedAuthCallback: typeof serializeParsedAuthCallback;
  readonly serializePoll: typeof serializePoll;
  readonly serializePost: typeof serializePost;
  readonly serializePostConnection: typeof serializePostConnection;
  readonly serializePostRevision: typeof serializePostRevision;
  readonly serializeRelationship: typeof serializeRelationship;
  readonly serializeScheduledPost: typeof serializeScheduledPost;
  readonly serializeScheduledPostConnection: typeof serializeScheduledPostConnection;
  readonly serializeSearchResult: typeof serializeSearchResult;
  readonly unsupportedGraphQLField: typeof unsupportedGraphQLField;
  readonly unsupportedGraphQLResolver: typeof unsupportedGraphQLResolver;
  readonly withGraphQLErrorContract: typeof withGraphQLErrorContract;
  readonly accountActionResolver: typeof accountActionResolver;
  readonly builder: BuilderLike;
  readonly postActionResolver: typeof postActionResolver;
};

function graphQLSessionId(context: GraphQLContext): string {
  return bearerSessionId(context.request.headers.get("authorization") ?? undefined);
}

function withGraphQLSession(input: unknown, context: GraphQLContext): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return { ...input, sessionId: graphQLSessionId(context) };
}

function withOptionalGraphQLSession(input: unknown, context: GraphQLContext): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return {
    ...input,
    ...optionalBearerSessionId(context.request.headers.get("authorization") ?? undefined),
  };
}

export function registerGraphQLOperations(deps: SchemaOperationDeps): void {
  const {
    AccountConnectionType,
    AccountType,
    AuthCallbackInput,
    AuthExchangeInput,
    AuthSessionType,
    AuthStartInput,
    AuthStartPayloadType,
    EmailChallengeStartInput,
    EmailChallengeStartPayloadType,
    EmailChallengeVerifyInput,
    BoostPostInput,
    CapabilitySet,
    CreateFilterInput,
    CreateListInput,
    CreatePostInput,
    DeletedEntityType,
    DetectInstanceInput,
    DeleteMediaInput,
    FilterConnectionType,
    FilterType,
    Health,
    InstanceType,
    ListConnectionType,
    ListAccountInput,
    ListType,
    MediaAttachmentType,
    MuteAccountInput,
    NotificationConnectionType,
    NotificationTypeInputEnum,
    ParsedAuthCallbackType,
    PollType,
    PostConnectionType,
    PostRevisionType,
    PostType,
    ReactPostInput,
    RelationshipType,
    SearchInput,
    SearchResultType,
    SchedulePostInput,
    ScheduledPostConnectionType,
    ScheduledPostType,
    TimelineConnectionType,
    UpdateFilterInput,
    UpdateListInput,
    UpdateMediaInput,
    UpdatePostInput,
    UpdateProfileInput,
    UpdateScheduledPostInput,
    UploadMediaFromUrlInput,
    UploadMediaInput,
    VotePollInput,
    activityPlugApiVersion,
    AdapterIdScalar,
    ImportTokenInput,
    PageInput,
    PasskeyFinishInput,
    PasskeyStartInput,
    PasskeyStartPayloadType,
    builder,
    enforceTokenImportPolicy,
    nonBlankString,
    normalizeAuthExchange,
    normalizeAuthStart,
    normalizeEmailChallengeStart,
    normalizeEmailChallengeVerify,
    normalizeBoostInput,
    normalizeCallbackInput,
    normalizeCreatePostInput,
    normalizeImportToken,
    normalizeMuteInput,
    normalizePasskeyFinish,
    normalizePasskeyStart,
    normalizePageInput,
    normalizeReactInput,
    normalizeSearchInput,
    normalizeUploadMediaInput,
    normalizeVotePollInput,
    serializeAccount,
    serializeAccountConnection,
    serializeAuthSession,
    serializeAuthStart,
    serializeCapabilitySetPayload,
    serializeDeletedEntity,
    serializeFilter,
    serializeFilterConnection,
    serializeInstanceProfile,
    serializeMediaAttachment,
    serializeList,
    serializeListConnection,
    serializeNotificationConnection,
    serializeParsedAuthCallback,
    serializePoll,
    serializePost,
    serializePostConnection,
    serializePostRevision,
    serializeRelationship,
    serializeScheduledPost,
    serializeScheduledPostConnection,
    serializeSearchResult,
    unsupportedGraphQLField,
    withGraphQLErrorContract,
    accountActionResolver,
    postActionResolver,
  } = deps;

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
          adapter: t.arg({ type: AdapterIdScalar, required: false }),
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
        args: {},
        type: AccountType,
        resolve: async (_parent, args, context) =>
          withGraphQLErrorContract(async () =>
            serializeAccount(
              (await context.service.viewer({ sessionId: graphQLSessionId(context) })).account,
            ),
          ),
      }),
      instance: unsupportedGraphQLField(t, {
        type: InstanceType,
        operation: "instance.get",
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
        },
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
          adapter: t.arg({ type: AdapterIdScalar }),
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
        args: {
          id: t.arg.id({ required: true }),
          page: t.arg({ type: PageInput }),
        },
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
                ...optionalBearerSessionId(
                  context.request.headers.get("authorization") ?? undefined,
                ),
              }),
            ),
          ),
      }),
      accountFollowers: unsupportedGraphQLField(t, {
        type: AccountConnectionType,
        operation: "account.followers",
        args: {
          id: t.arg.id({ required: true }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly id: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeAccountConnection(
              await context.service.accounts.followers({
                id: args.id,
                page: normalizePageInput(args.page),
                ...optionalBearerSessionId(
                  context.request.headers.get("authorization") ?? undefined,
                ),
              }),
            ),
          ),
      }),
      accountFollowing: unsupportedGraphQLField(t, {
        type: AccountConnectionType,
        operation: "account.following",
        args: {
          id: t.arg.id({ required: true }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly id: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeAccountConnection(
              await context.service.accounts.following({
                id: args.id,
                page: normalizePageInput(args.page),
                ...optionalBearerSessionId(
                  context.request.headers.get("authorization") ?? undefined,
                ),
              }),
            ),
          ),
      }),
      accountRelationship: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "account.relationships",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeRelationship(
              await context.service.social.relationship({
                accountId: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      post: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "post.get",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (_parent: unknown, args: { readonly id: string }, context: GraphQLContext) =>
          withGraphQLErrorContract(async () =>
            serializePost(
              await context.service.posts.get({
                id: args.id,
                ...optionalBearerSessionId(
                  context.request.headers.get("authorization") ?? undefined,
                ),
              }),
            ),
          ),
      }),
      postHistory: unsupportedGraphQLField(t, {
        type: [PostRevisionType],
        nullable: true,
        operation: "post.history",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId?: string | null },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            (
              await context.service.posts.history({
                id: args.id,
                ...optionalBearerSessionId(
                  context.request.headers.get("authorization") ?? undefined,
                ),
              })
            ).map((revision) => serializePostRevision(revision)),
          ),
      }),
      homeTimeline: unsupportedGraphQLField(t, {
        type: TimelineConnectionType,
        operation: "timeline.home",
        args: {
          origin: t.arg.string({ required: true }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly origin: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePostConnection(
              await context.service.timelines.home({
                origin: args.origin,
                sessionId: graphQLSessionId(context),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      publicTimeline: unsupportedGraphQLField(t, {
        type: TimelineConnectionType,
        operation: "timeline.public",
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
          local: t.arg.boolean(),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly origin: string;
            readonly adapter?: AdapterKind | null;
            readonly local?: boolean | null;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePostConnection(
              await context.service.timelines.public({
                origin: args.origin,
                ...(args.adapter === null || args.adapter === undefined
                  ? {}
                  : { adapter: args.adapter }),
                ...optionalBearerSessionId(
                  context.request.headers.get("authorization") ?? undefined,
                ),
                ...(args.local === null || args.local === undefined ? {} : { local: args.local }),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      hashtagTimeline: unsupportedGraphQLField(t, {
        type: TimelineConnectionType,
        operation: "timeline.hashtag",
        args: {
          origin: t.arg.string({ required: true }),
          tag: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly origin: string;
            readonly tag: string;
            readonly adapter?: AdapterKind | null;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePostConnection(
              await context.service.timelines.hashtag({
                origin: args.origin,
                tag: nonBlankString(args.tag, "tag"),
                ...(args.adapter === null || args.adapter === undefined
                  ? {}
                  : { adapter: args.adapter }),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      listTimeline: unsupportedGraphQLField(t, {
        type: TimelineConnectionType,
        operation: "timeline.list",
        args: {
          listId: t.arg.id({ required: true }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly listId: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePostConnection(
              await context.service.lists.timeline({
                id: args.listId,
                sessionId: graphQLSessionId(context),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      search: unsupportedGraphQLField(t, {
        type: SearchResultType,
        operation: "search",
        args: { input: t.arg({ type: SearchInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeSearchResult(
              await context.service.search.search(
                normalizeSearchInput(withOptionalGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      notifications: unsupportedGraphQLField(t, {
        type: NotificationConnectionType,
        operation: "notification.list",
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
          types: t.arg({ type: [NotificationTypeInputEnum] }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly adapter?: AdapterKind | null;
            readonly origin: string;
            readonly types?: readonly string[] | null;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeNotificationConnection(
              await context.service.notifications.list({
                origin: args.origin,
                ...(args.adapter === null || args.adapter === undefined
                  ? {}
                  : { adapter: args.adapter }),
                sessionId: graphQLSessionId(context),
                ...(args.types === null || args.types === undefined
                  ? {}
                  : { types: args.types.map((type) => notificationTypeInput(type)) }),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      notificationUnreadCount: t.int({
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
        },
        resolve: async (
          _parent,
          args: {
            readonly adapter?: AdapterKind | null;
            readonly origin: string;
          },
          context,
        ) =>
          withGraphQLErrorContract(() =>
            context.service.notifications.unreadCount({
              origin: args.origin,
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
              sessionId: graphQLSessionId(context),
            }),
          ),
      }),
      followRequests: unsupportedGraphQLField(t, {
        type: AccountConnectionType,
        operation: "followRequest.list",
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly adapter?: AdapterKind | null;
            readonly origin: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeAccountConnection(
              await context.service.followRequests.list({
                origin: args.origin,
                ...(args.adapter === null || args.adapter === undefined
                  ? {}
                  : { adapter: args.adapter }),
                sessionId: graphQLSessionId(context),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      poll: unsupportedGraphQLField(t, {
        type: PollType,
        operation: "poll.get",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId?: string | null },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePoll(
              await context.service.polls.get({
                id: args.id,
                ...optionalBearerSessionId(
                  context.request.headers.get("authorization") ?? undefined,
                ),
              }),
            ),
          ),
      }),
      lists: unsupportedGraphQLField(t, {
        type: ListConnectionType,
        operation: "list.list",
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly adapter?: AdapterKind | null;
            readonly origin: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeListConnection(
              await context.service.lists.list({
                origin: args.origin,
                ...(args.adapter === null || args.adapter === undefined
                  ? {}
                  : { adapter: args.adapter }),
                sessionId: graphQLSessionId(context),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      list: unsupportedGraphQLField(t, {
        type: ListType,
        operation: "list.get",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeList(
              await context.service.lists.get({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      listAccounts: unsupportedGraphQLField(t, {
        type: AccountConnectionType,
        operation: "list.accounts",
        args: {
          id: t.arg.id({ required: true }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly id: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeAccountConnection(
              await context.service.lists.accounts({
                id: args.id,
                sessionId: graphQLSessionId(context),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      filters: unsupportedGraphQLField(t, {
        type: FilterConnectionType,
        operation: "filter.list",
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly adapter?: AdapterKind | null;
            readonly origin: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeFilterConnection(
              await context.service.filters.list({
                origin: args.origin,
                ...(args.adapter === null || args.adapter === undefined
                  ? {}
                  : { adapter: args.adapter }),
                sessionId: graphQLSessionId(context),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      filter: unsupportedGraphQLField(t, {
        type: FilterType,
        operation: "filter.get",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeFilter(
              await context.service.filters.get({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      scheduledPosts: unsupportedGraphQLField(t, {
        type: ScheduledPostConnectionType,
        operation: "scheduledPost.list",
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly adapter?: AdapterKind | null;
            readonly origin: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeScheduledPostConnection(
              await context.service.scheduledPosts.list({
                origin: args.origin,
                ...(args.adapter === null || args.adapter === undefined
                  ? {}
                  : { adapter: args.adapter }),
                sessionId: graphQLSessionId(context),
                page: normalizePageInput(args.page),
              }),
            ),
          ),
      }),
      scheduledPost: unsupportedGraphQLField(t, {
        type: ScheduledPostType,
        operation: "scheduledPost.get",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeScheduledPost(
              await context.service.scheduledPosts.get({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
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
          withGraphQLErrorContract(async () => {
            const input = { ...normalizeAuthStart(args.input), clientIp: context.clientIp };
            return serializeAuthStart(await context.service.auth.start(input));
          }),
      }),
      authEmailChallengeStart: t.field({
        args: {
          input: t.arg({ type: EmailChallengeStartInput, required: true }),
        },
        type: EmailChallengeStartPayloadType,
        resolve: async (
          _parent: unknown,
          args: { readonly input: Parameters<typeof normalizeEmailChallengeStart>[0] },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(() => {
            const input = {
              ...normalizeEmailChallengeStart(args.input),
              clientIp: context.clientIp,
            };
            return context.service.auth.emailChallenge.start(input);
          }),
      }),
      authEmailChallengeVerify: t.field({
        args: {
          input: t.arg({ type: EmailChallengeVerifyInput, required: true }),
        },
        type: AuthSessionType,
        resolve: async (
          _parent: unknown,
          args: { readonly input: Parameters<typeof normalizeEmailChallengeVerify>[0] },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeAuthSession(
              await context.service.auth.emailChallenge.verify(
                normalizeEmailChallengeVerify(args.input),
              ),
            ),
          ),
      }),
      authPasskeyStart: t.field({
        args: {
          input: t.arg({ type: PasskeyStartInput, required: true }),
        },
        type: PasskeyStartPayloadType,
        resolve: async (
          _parent: unknown,
          args: { readonly input: Parameters<typeof normalizePasskeyStart>[0] },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(() => {
            const input = { ...normalizePasskeyStart(args.input), clientIp: context.clientIp };
            return context.service.auth.passkey.start(input);
          }),
      }),
      authPasskeyFinish: t.field({
        args: {
          input: t.arg({ type: PasskeyFinishInput, required: true }),
        },
        type: AuthSessionType,
        resolve: async (
          _parent: unknown,
          args: { readonly input: Parameters<typeof normalizePasskeyFinish>[0] },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeAuthSession(
              await context.service.auth.passkey.finish(normalizePasskeyFinish(args.input)),
            ),
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
        args: {},
        type: AuthSessionType,
        resolve: async (_parent, args, context) =>
          withGraphQLErrorContract(async () =>
            serializeAuthSession(
              await context.service.auth.refreshSession({ sessionId: graphQLSessionId(context) }),
            ),
          ),
      }),
      authRevoke: t.boolean({
        args: {},
        resolve: async (_parent, args, context) =>
          withGraphQLErrorContract(async () => {
            await context.service.auth.revokeSession({ sessionId: graphQLSessionId(context) });
            return true;
          }),
      }),
      uploadMedia: unsupportedGraphQLField(t, {
        type: MediaAttachmentType,
        operation: "media.upload",
        args: { input: t.arg({ type: UploadMediaInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeMediaAttachment(
              await context.service.media.upload(
                normalizeUploadMediaInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      ingestMediaFromUrl: unsupportedGraphQLField(t, {
        type: MediaAttachmentType,
        operation: "media.ingestUrl",
        args: { input: t.arg({ type: UploadMediaFromUrlInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeMediaAttachment(
              await context.service.media.uploadFromUrl(
                uploadMediaFromUrlInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      updateMedia: unsupportedGraphQLField(t, {
        type: MediaAttachmentType,
        operation: "media.update",
        args: { input: t.arg({ type: UpdateMediaInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeMediaAttachment(
              await context.service.media.update(
                updateMediaInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      deleteMedia: unsupportedGraphQLField(t, {
        type: DeletedEntityType,
        operation: "media.delete",
        args: { input: t.arg({ type: DeleteMediaInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeDeletedEntity(
              await context.service.media.delete(
                deleteMediaInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      updateProfile: unsupportedGraphQLField(t, {
        type: AccountType,
        operation: "account.updateProfile",
        args: { input: t.arg({ type: UpdateProfileInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeAccount(
              await context.service.accounts.updateProfile(
                updateProfileInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      createPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "post.create",
        args: { input: t.arg({ type: CreatePostInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePost(
              await context.service.posts.create(
                normalizeCreatePostInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      updatePost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "post.update",
        args: { input: t.arg({ type: UpdatePostInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePost(
              await context.service.posts.update(
                postUpdateInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      schedulePost: unsupportedGraphQLField(t, {
        type: ScheduledPostType,
        operation: "scheduledPost.create",
        args: { input: t.arg({ type: SchedulePostInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeScheduledPost(
              await context.service.scheduledPosts.create(
                schedulePostInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      updateScheduledPost: unsupportedGraphQLField(t, {
        type: ScheduledPostType,
        operation: "scheduledPost.update",
        args: { input: t.arg({ type: UpdateScheduledPostInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeScheduledPost(
              await context.service.scheduledPosts.update(
                updateScheduledPostInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      deleteScheduledPost: unsupportedGraphQLField(t, {
        type: DeletedEntityType,
        operation: "scheduledPost.delete",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeDeletedEntity(
              await context.service.scheduledPosts.delete({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      deletePost: unsupportedGraphQLField(t, {
        type: DeletedEntityType,
        operation: "post.delete",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeDeletedEntity(
              await context.service.posts.delete({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      followAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.follow",
        args: { id: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.follow(input)),
      }),
      unfollowAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.unfollow",
        args: { id: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.unfollow(input)),
      }),
      blockAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.block",
        args: { id: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.block(input)),
      }),
      unblockAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.unblock",
        args: { id: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.unblock(input)),
      }),
      muteAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.mute",
        args: { input: t.arg({ type: MuteAccountInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeRelationship(
              await context.service.social.mute(
                normalizeMuteInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      unmuteAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.unmute",
        args: { id: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.unmute(input)),
      }),
      favouritePost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.favourite",
        args: { id: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.favourite(input)),
      }),
      unfavouritePost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.unfavourite",
        args: { id: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.unfavourite(input)),
      }),
      bookmarkPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.bookmark",
        args: { id: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.bookmark(input)),
      }),
      unbookmarkPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.unbookmark",
        args: { id: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.unbookmark(input)),
      }),
      boostPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.boost",
        args: { input: t.arg({ type: BoostPostInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePost(
              await context.service.social.boost(
                normalizeBoostInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      unboostPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.unboost",
        args: { id: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.unboost(input)),
      }),
      reactToPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.reaction",
        args: { input: t.arg({ type: ReactPostInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePost(
              await context.service.social.react(
                normalizeReactInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      unreactToPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.unreaction",
        args: { input: t.arg({ type: ReactPostInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePost(
              await context.service.social.unreact(
                normalizeReactInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      votePoll: unsupportedGraphQLField(t, {
        type: PollType,
        operation: "poll.vote",
        args: { input: t.arg({ type: VotePollInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePoll(
              await context.service.polls.vote(
                normalizeVotePollInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      acceptFollowRequest: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "followRequest.accept",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeRelationship(
              await context.service.followRequests.accept({
                accountId: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      rejectFollowRequest: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "followRequest.reject",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeRelationship(
              await context.service.followRequests.reject({
                accountId: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      createList: unsupportedGraphQLField(t, {
        type: ListType,
        operation: "list.create",
        args: { input: t.arg({ type: CreateListInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeList(
              await context.service.lists.create(
                listInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      updateList: unsupportedGraphQLField(t, {
        type: ListType,
        operation: "list.update",
        args: { input: t.arg({ type: UpdateListInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeList(
              await context.service.lists.update(
                updateListInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      deleteList: unsupportedGraphQLField(t, {
        type: DeletedEntityType,
        operation: "list.delete",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeDeletedEntity(
              await context.service.lists.delete({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      addListAccount: unsupportedGraphQLField(t, {
        type: ListType,
        operation: "list.account.add",
        args: { input: t.arg({ type: ListAccountInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeList(
              await context.service.lists.addAccount(
                listAccountInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      removeListAccount: unsupportedGraphQLField(t, {
        type: ListType,
        operation: "list.account.remove",
        args: { input: t.arg({ type: ListAccountInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeList(
              await context.service.lists.removeAccount(
                listAccountInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      createFilter: unsupportedGraphQLField(t, {
        type: FilterType,
        operation: "filter.create",
        args: { input: t.arg({ type: CreateFilterInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeFilter(
              await context.service.filters.create(
                filterInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      updateFilter: unsupportedGraphQLField(t, {
        type: FilterType,
        operation: "filter.update",
        args: { input: t.arg({ type: UpdateFilterInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeFilter(
              await context.service.filters.update(
                updateFilterInput(withGraphQLSession(args.input, context)),
              ),
            ),
          ),
      }),
      deleteFilter: unsupportedGraphQLField(t, {
        type: DeletedEntityType,
        operation: "filter.delete",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeDeletedEntity(
              await context.service.filters.delete({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      dismissNotification: unsupportedGraphQLField(t, {
        type: DeletedEntityType,
        operation: "notification.dismiss",
        args: { id: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeDeletedEntity(
              await context.service.notifications.dismiss({
                id: args.id,
                sessionId: graphQLSessionId(context),
              }),
            ),
          ),
      }),
      clearNotifications: t.boolean({
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterIdScalar }),
        },
        resolve: async (_parent, args, context) =>
          withGraphQLErrorContract(async () => {
            await context.service.notifications.clear({
              origin: args.origin,
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
              sessionId: graphQLSessionId(context),
            });
            return true;
          }),
      }),
    }),
  });
}
