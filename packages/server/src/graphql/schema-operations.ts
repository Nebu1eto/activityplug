import {
  type serializeAccount,
  type serializeAuthSession,
  type serializeAuthStart,
  type serializeCapabilitySetPayload,
  type serializeDeletedEntity,
  type serializeInstanceProfile,
  type serializeMediaAttachment,
  type serializeParsedAuthCallback,
  type serializePoll,
  type serializePost,
  type serializePostConnection,
  type serializeRelationship,
  type serializeSearchResult,
} from "../api/service.js";
import {
  type accountActionResolver,
  type normalizeAuthExchange,
  type normalizeAuthStart,
  type normalizeBoostInput,
  type normalizeCallbackInput,
  type normalizeCreatePostInput,
  type normalizeImportToken,
  type normalizeMuteInput,
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
  readonly BoostPostInput: unknown;
  readonly CapabilitySet: unknown;
  readonly CreatePostInput: unknown;
  readonly DeletedEntityType: unknown;
  readonly DetectInstanceInput: unknown;
  readonly Health: unknown;
  readonly InstanceType: unknown;
  readonly JsonInput: unknown;
  readonly ListConnectionType: unknown;
  readonly ListType: unknown;
  readonly MediaAttachmentType: unknown;
  readonly MuteAccountInput: unknown;
  readonly NotificationConnectionType: unknown;
  readonly PageInput: unknown;
  readonly ParsedAuthCallbackType: unknown;
  readonly PollType: unknown;
  readonly PostConnectionType: unknown;
  readonly PostContextType: unknown;
  readonly PostType: unknown;
  readonly ReactPostInput: unknown;
  readonly RelationshipType: unknown;
  readonly SearchInput: unknown;
  readonly SearchResultType: unknown;
  readonly TimelineConnectionType: unknown;
  readonly UploadMediaInput: unknown;
  readonly VotePollInput: unknown;
  readonly activityPlugApiVersion: string;
  readonly AdapterKindEnum: unknown;
  readonly ImportTokenInput: unknown;
  readonly enforceTokenImportPolicy: (context: GraphQLContext) => Promise<void>;
  readonly nonBlankString: (value: string, field: string) => string;
  readonly normalizeAuthExchange: typeof normalizeAuthExchange;
  readonly normalizeAuthStart: typeof normalizeAuthStart;
  readonly normalizeBoostInput: typeof normalizeBoostInput;
  readonly normalizeCallbackInput: typeof normalizeCallbackInput;
  readonly normalizeCreatePostInput: typeof normalizeCreatePostInput;
  readonly normalizeImportToken: typeof normalizeImportToken;
  readonly normalizeMuteInput: typeof normalizeMuteInput;
  readonly normalizePageInput: typeof normalizePageInput;
  readonly normalizeReactInput: typeof normalizeReactInput;
  readonly normalizeSearchInput: typeof normalizeSearchInput;
  readonly normalizeUploadMediaInput: typeof normalizeUploadMediaInput;
  readonly normalizeVotePollInput: typeof normalizeVotePollInput;
  readonly serializeAccount: typeof serializeAccount;
  readonly serializeAuthSession: typeof serializeAuthSession;
  readonly serializeAuthStart: typeof serializeAuthStart;
  readonly serializeCapabilitySetPayload: typeof serializeCapabilitySetPayload;
  readonly serializeDeletedEntity: typeof serializeDeletedEntity;
  readonly serializeInstanceProfile: typeof serializeInstanceProfile;
  readonly serializeMediaAttachment: typeof serializeMediaAttachment;
  readonly serializeParsedAuthCallback: typeof serializeParsedAuthCallback;
  readonly serializePoll: typeof serializePoll;
  readonly serializePost: typeof serializePost;
  readonly serializePostConnection: typeof serializePostConnection;
  readonly serializeRelationship: typeof serializeRelationship;
  readonly serializeSearchResult: typeof serializeSearchResult;
  readonly unsupportedGraphQLField: typeof unsupportedGraphQLField;
  readonly unsupportedGraphQLResolver: typeof unsupportedGraphQLResolver;
  readonly withGraphQLErrorContract: typeof withGraphQLErrorContract;
  readonly accountActionResolver: typeof accountActionResolver;
  readonly builder: BuilderLike;
  readonly postActionResolver: typeof postActionResolver;
};

export function registerGraphQLOperations(deps: SchemaOperationDeps): void {
  const {
    AccountConnectionType,
    AccountType,
    AuthCallbackInput,
    AuthExchangeInput,
    AuthSessionType,
    AuthStartInput,
    AuthStartPayloadType,
    BoostPostInput,
    CapabilitySet,
    CreatePostInput,
    DeletedEntityType,
    DetectInstanceInput,
    Health,
    InstanceType,
    JsonInput,
    ListConnectionType,
    ListType,
    MediaAttachmentType,
    MuteAccountInput,
    NotificationConnectionType,
    ParsedAuthCallbackType,
    PollType,
    PostConnectionType,
    PostContextType,
    PostType,
    ReactPostInput,
    RelationshipType,
    SearchInput,
    SearchResultType,
    TimelineConnectionType,
    UploadMediaInput,
    VotePollInput,
    activityPlugApiVersion,
    AdapterKindEnum,
    ImportTokenInput,
    PageInput,
    builder,
    enforceTokenImportPolicy,
    nonBlankString,
    normalizeAuthExchange,
    normalizeAuthStart,
    normalizeBoostInput,
    normalizeCallbackInput,
    normalizeCreatePostInput,
    normalizeImportToken,
    normalizeMuteInput,
    normalizePageInput,
    normalizeReactInput,
    normalizeSearchInput,
    normalizeUploadMediaInput,
    normalizeVotePollInput,
    serializeAccount,
    serializeAuthSession,
    serializeAuthStart,
    serializeCapabilitySetPayload,
    serializeDeletedEntity,
    serializeInstanceProfile,
    serializeMediaAttachment,
    serializeParsedAuthCallback,
    serializePoll,
    serializePost,
    serializePostConnection,
    serializeRelationship,
    serializeSearchResult,
    unsupportedGraphQLField,
    unsupportedGraphQLResolver,
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
        args: {
          origin: t.arg.string({ required: true }),
          adapter: t.arg({ type: AdapterKindEnum }),
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
        args: {
          id: t.arg.id({ required: true }),
          page: t.arg({ type: PageInput }),
          sessionId: t.arg.id(),
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
            readonly sessionId?: string | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePostConnection(
              await context.service.accounts.posts({
                id: args.id,
                page: normalizePageInput(args.page),
                ...(args.sessionId === null || args.sessionId === undefined
                  ? {}
                  : { sessionId: args.sessionId }),
              }),
            ),
          ),
      }),
      accountRelationship: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "account.relationships",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeRelationship(
              await context.service.social.relationship({
                accountId: args.id,
                sessionId: args.sessionId,
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
            serializePost(await context.service.posts.get({ id: args.id })),
          ),
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
        resolve: async (
          _parent: unknown,
          args: {
            readonly origin: string;
            readonly sessionId: string;
            readonly page?: PageInputValue | null;
          },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePostConnection(
              await context.service.timelines.home({
                origin: args.origin,
                sessionId: args.sessionId,
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
          adapter: t.arg({ type: AdapterKindEnum }),
          sessionId: t.arg.id(),
          local: t.arg.boolean(),
          page: t.arg({ type: PageInput }),
        },
        resolve: async (
          _parent: unknown,
          args: {
            readonly origin: string;
            readonly adapter?: AdapterKind | null;
            readonly sessionId?: string | null;
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
                ...(args.sessionId === null || args.sessionId === undefined
                  ? {}
                  : { sessionId: args.sessionId }),
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
          adapter: t.arg({ type: AdapterKindEnum }),
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
        args: { listId: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
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
              await context.service.search.search(normalizeSearchInput(args.input)),
            ),
          ),
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
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: false }) },
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId?: string | null },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializePoll(
              await context.service.polls.get({
                id: args.id,
                ...(args.sessionId === null || args.sessionId === undefined
                  ? {}
                  : { sessionId: args.sessionId }),
              }),
            ),
          ),
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
        args: { input: t.arg({ type: UploadMediaInput, required: true }) },
        resolve: async (
          _parent: unknown,
          args: { readonly input: unknown },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeMediaAttachment(
              await context.service.media.upload(normalizeUploadMediaInput(args.input)),
            ),
          ),
      }),
      ingestMediaFromUrl: unsupportedGraphQLField(t, {
        type: MediaAttachmentType,
        operation: "media.ingestUrl",
        args: { input: t.arg({ type: JsonInput, required: true }) },
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
            serializePost(await context.service.posts.create(normalizeCreatePostInput(args.input))),
          ),
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
        resolve: async (
          _parent: unknown,
          args: { readonly id: string; readonly sessionId: string },
          context: GraphQLContext,
        ) =>
          withGraphQLErrorContract(async () =>
            serializeDeletedEntity(
              await context.service.posts.delete({ id: args.id, sessionId: args.sessionId }),
            ),
          ),
      }),
      followAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.follow",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.follow(input)),
      }),
      unfollowAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.unfollow",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.unfollow(input)),
      }),
      blockAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.block",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.block(input)),
      }),
      unblockAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.unblock",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
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
              await context.service.social.mute(normalizeMuteInput(args.input)),
            ),
          ),
      }),
      unmuteAccount: unsupportedGraphQLField(t, {
        type: RelationshipType,
        operation: "social.unmute",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: accountActionResolver((service, input) => service.social.unmute(input)),
      }),
      favouritePost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.favourite",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.favourite(input)),
      }),
      unfavouritePost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.unfavourite",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.unfavourite(input)),
      }),
      bookmarkPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.bookmark",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
        resolve: postActionResolver((service, input) => service.social.bookmark(input)),
      }),
      unbookmarkPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.unbookmark",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
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
            serializePost(await context.service.social.boost(normalizeBoostInput(args.input))),
          ),
      }),
      unboostPost: unsupportedGraphQLField(t, {
        type: PostType,
        operation: "social.unboost",
        args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
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
            serializePost(await context.service.social.react(normalizeReactInput(args.input))),
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
            serializePost(await context.service.social.unreact(normalizeReactInput(args.input))),
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
            serializePoll(await context.service.polls.vote(normalizeVotePollInput(args.input))),
          ),
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
}
