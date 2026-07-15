import {
  ActivityPlugError,
  createActivityPlugClient,
  createRemoteAuthority,
  type Account,
  type AuthSession,
  type Connection,
  type Post,
  type PostVisibility,
  type RemoteAuthority,
  type Relationship,
} from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";

export type BotAdapter = "mastodon" | "misskey";

export interface CreateBotClientInput {
  readonly adapter: BotAdapter;
  readonly origin: string;
  readonly accessToken: string;
  readonly scopes?: readonly string[];
  readonly remoteAuthority?: RemoteAuthority;
  readonly fetch?: typeof globalThis.fetch;
}

export interface BotClient {
  readonly session: AuthSession;
  readonly verifyViewer: () => Promise<Account>;
  readonly pollHomeTimeline: (limit?: number) => Promise<Connection<Post>>;
  readonly findMentions: (posts: readonly Post[], username: string) => readonly Post[];
  readonly replyToMention: (
    postId: string,
    content: string,
    sourceVisibility?: PostVisibility,
  ) => Promise<Post>;
  readonly acknowledgeMention: (postId: string, emoji: string) => Promise<Post>;
  readonly handleTimelineMentions: (input: HandleTimelineMentionsInput) => Promise<readonly Post[]>;
  readonly follow: (accountId: string) => Promise<Relationship>;
  readonly unfollow: (accountId: string) => Promise<Relationship>;
  readonly block: (accountId: string) => Promise<Relationship>;
  readonly reactToMention: (postId: string, emoji: string) => Promise<Post>;
  readonly favouriteMention: (postId: string) => Promise<Post>;
}

export interface HandleTimelineMentionsInput {
  readonly username: string;
  readonly reply: (post: Post) => string | undefined;
  readonly limit?: number;
  readonly acknowledgementEmoji?: string;
}

export async function createBotClient(input: CreateBotClientInput): Promise<BotClient> {
  const client = createActivityPlugClient({
    adapter: input.adapter === "mastodon" ? createMastodonAdapter() : createMisskeyAdapter(),
    origin: input.origin,
    ...(input.remoteAuthority !== undefined
      ? { remoteAuthority: input.remoteAuthority }
      : input.fetch === undefined
        ? {}
        : { remoteAuthority: createRemoteAuthority({ transport: input.fetch }) }),
  });
  const session = await client.auth.injectToken({
    accessToken: input.accessToken,
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
  });
  return {
    session,
    verifyViewer: async () => (await client.auth.verifyCredentials(session)).account,
    pollHomeTimeline: (limit = 20) => client.timelines.home({ session, page: { limit } }),
    findMentions: (posts, username) => posts.filter((post) => mentionsUsername(post, username)),
    replyToMention: (postId, content, sourceVisibility = "unknown") =>
      client.posts.create({
        session,
        content,
        replyToId: postId,
        visibility: safeReplyVisibility(sourceVisibility),
      }),
    acknowledgeMention: async (postId, emoji) => {
      try {
        return await client.social.react({ session, postId, emoji });
      } catch (error) {
        if (error instanceof ActivityPlugError && error.code === "UNSUPPORTED_OPERATION") {
          return client.social.favourite({ session, postId });
        }
        throw error;
      }
    },
    handleTimelineMentions: async ({ username, reply, limit, acknowledgementEmoji }) => {
      const timeline = await client.timelines.home({ session, page: { limit: limit ?? 20 } });
      const mentions = timeline.nodes.filter((post) => mentionsUsername(post, username));
      const replies: Post[] = [];
      for (const mention of mentions) {
        const content = reply(mention);
        if (content === undefined) continue;
        replies.push(
          await client.posts.create({
            session,
            content,
            replyToId: mention.ref.id,
            visibility: safeReplyVisibility(mention.visibility),
          }),
        );
        if (acknowledgementEmoji !== undefined) {
          await acknowledgePost(client, session, mention.ref.id, acknowledgementEmoji);
        }
      }
      return replies;
    },
    follow: (accountId) => client.social.follow({ session, accountId }),
    unfollow: (accountId) => client.social.unfollow({ session, accountId }),
    block: (accountId) => client.social.block({ session, accountId }),
    reactToMention: async (postId, emoji) => client.social.react({ session, postId, emoji }),
    favouriteMention: (postId) => client.social.favourite({ session, postId }),
  };
}

function mentionsUsername(post: Post, username: string): boolean {
  if (username.length === 0) return false;
  const escapedUsername = escapeRegExp(username);
  const mention = new RegExp(
    `(?<![\\p{L}\\p{N}_])@${escapedUsername}(?![\\p{L}\\p{N}_@]|[.-][\\p{L}\\p{N}])`,
    "iu",
  );
  return mention.test(`${post.contentText ?? ""} ${stripHtml(post.contentHtml)}`);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function safeReplyVisibility(
  sourceVisibility: PostVisibility,
): "public" | "unlisted" | "followers" | "direct" {
  switch (sourceVisibility) {
    case "public":
    case "unlisted":
    case "followers":
    case "direct":
      return sourceVisibility;
    default:
      // Portable `followers` is the private/followers-only visibility used
      // when a remote visibility cannot be represented without escalation.
      return "followers";
  }
}

function stripHtml(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, " ");
}

async function acknowledgePost(
  client: ReturnType<typeof createActivityPlugClient>,
  session: AuthSession,
  postId: string,
  emoji: string,
): Promise<Post> {
  try {
    return await client.social.react({ session, postId, emoji });
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "UNSUPPORTED_OPERATION") {
      return client.social.favourite({ session, postId });
    }
    throw error;
  }
}
