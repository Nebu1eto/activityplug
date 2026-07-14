import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { type ReactElement, useId } from "react";

import { webKeys } from "../../api/client.js";
import { productRouteHref } from "../../routing/location.js";
import { PostCard, type PostCardViewModel } from "../posts/post-card.js";
import { SafeHtml } from "../posts/safe-html.js";
import { productInfiniteQueryMaxPages } from "../timeline/queries.js";

export interface ProfileEntityRef {
  readonly id: string;
  readonly type?: string;
  readonly adapter?: string;
  readonly origin?: string;
  readonly url?: string;
}

export interface ProfileSummary {
  readonly ref: ProfileEntityRef;
  readonly username: string;
  readonly handle: string;
  readonly displayName: string;
  readonly url?: string;
  readonly avatarUrl?: string;
  readonly bot: boolean;
  readonly locked: boolean;
}

export interface Profile extends ProfileSummary {
  readonly headerUrl?: string;
  readonly createdAt?: string;
  readonly bioHtml?: string;
  readonly fields: readonly {
    readonly name: string;
    readonly valueHtml: string;
    readonly verifiedAt?: string;
  }[];
  readonly followersCount?: number;
  readonly followingCount?: number;
  readonly postsCount?: number;
}

export interface ProfilePost {
  readonly ref: ProfileEntityRef;
  readonly author: ProfileSummary;
  readonly contentHtml: string;
  readonly createdAt: string;
  readonly sensitive: boolean;
  readonly summary?: string;
  readonly media: readonly {
    readonly ref: ProfileEntityRef;
    readonly type: "image" | "video" | "audio" | "gifv" | "unknown";
    readonly url: string;
    readonly previewUrl?: string;
    readonly description?: string;
  }[];
  readonly replyTo?: ProfileEntityRef;
  readonly quoteOf?: ProfileEntityRef;
  readonly boostOf?: ProfileEntityRef;
  readonly counts?: {
    readonly replies?: number;
    readonly reblogs?: number;
    readonly favourites?: number;
  };
}

export interface ProfileRelationship {
  readonly account: ProfileEntityRef;
  readonly following: boolean;
  readonly followedBy: boolean;
  readonly requested: boolean;
  readonly blocking: boolean;
  readonly blockedBy?: boolean;
  readonly muting: boolean;
  readonly mutingNotifications?: boolean;
  readonly domainBlocking?: boolean;
  readonly showingReblogs?: boolean;
  readonly notifying?: boolean;
}

export interface ProfileResponse {
  readonly profile: Profile;
  readonly posts: readonly ProfilePost[];
  readonly pageInfo: { readonly nextCursor: string | null };
  readonly relationship?: ProfileRelationship;
}

export interface ProfileApi {
  readonly profile: (id: string, cursor?: string, signal?: AbortSignal) => Promise<ProfileResponse>;
  readonly followProfile: (id: string) => Promise<ProfileResponse>;
  readonly unfollowProfile: (id: string) => Promise<ProfileResponse>;
}

export interface FollowCapability {
  readonly name: "social.follow";
  readonly status: "supported" | "unsupported" | "unknown";
  readonly reason: string | null;
}

export interface ProfileLabels {
  readonly avatar: (name: string) => string;
  readonly bot: string;
  readonly locked: string;
  readonly follow: string;
  readonly unfollow: string;
  readonly followers: string;
  readonly following: string;
  readonly postsCount: string;
  readonly fields: string;
  readonly loading: string;
  readonly failed: string;
  readonly loadMore: string;
  readonly loadingMore: string;
  readonly emptyPosts: string;
  readonly relationshipUnavailable: string;
}

export interface ProfileViewProps {
  readonly api: ProfileApi;
  readonly id: string;
  readonly followCapability: FollowCapability;
  readonly labels?: Partial<ProfileLabels>;
  readonly renderPost?: (post: ProfilePost) => ReactElement;
}

const defaultLabels: ProfileLabels = {
  avatar: (name) => `${name} avatar`,
  bot: "Bot account",
  locked: "Locked account",
  follow: "Follow",
  unfollow: "Unfollow",
  followers: "Followers",
  following: "Following",
  postsCount: "Posts",
  fields: "Profile fields",
  loading: "Loading profile",
  failed: "The profile could not be loaded.",
  loadMore: "Load more posts",
  loadingMore: "Loading more posts",
  emptyPosts: "No posts are available.",
  relationshipUnavailable: "Follow state is unavailable.",
};

export const profileQueryKey = (id: string) => webKeys.profile(id);

export function ProfileView({
  api,
  id,
  followCapability,
  labels: labelOverrides,
  renderPost,
}: ProfileViewProps): ReactElement {
  const labels = { ...defaultLabels, ...labelOverrides };
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: profileQueryKey(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.profile(id, pageParam, signal),
    getNextPageParam: (lastPage, allPages) =>
      allPages.length >= productInfiniteQueryMaxPages
        ? undefined
        : (lastPage.pageInfo.nextCursor ?? undefined),
    enabled: id.length > 0,
    retry: false,
  });
  const firstPage = query.data?.pages[0];
  const profile = firstPage?.profile;
  const relationship = firstPage?.relationship;
  const posts = query.data?.pages.flatMap((page) => page.posts) ?? [];
  const relationshipMutation = useMutation({
    mutationFn: async ({
      id: mutationId,
      following,
    }: {
      readonly id: string;
      readonly following: boolean;
    }) => (following ? api.unfollowProfile(mutationId) : api.followProfile(mutationId)),
    onSuccess: (response, { id: mutationId }) => {
      client.setQueryData<InfiniteData<ProfileResponse, string | undefined>>(
        profileQueryKey(mutationId),
        (current) => {
          if (current === undefined || current.pages.length === 0) {
            return { pages: [response], pageParams: [undefined] };
          }
          return {
            ...current,
            pages: current.pages.map((page, index) =>
              index === 0
                ? {
                    ...page,
                    profile: response.profile,
                    ...(response.relationship === undefined
                      ? { relationship: undefined }
                      : { relationship: response.relationship }),
                  }
                : page,
            ),
          };
        },
      );
    },
  });
  const relationshipReasonId = useId();

  if (query.isPending) return <p>{labels.loading}</p>;
  if (query.error !== null) return <p role="alert">{errorMessage(query.error, labels.failed)}</p>;
  if (profile === undefined) return <p role="alert">{labels.failed}</p>;

  return (
    <article
      aria-busy={query.isFetchingNextPage || relationshipMutation.isPending}
      className="profile-view"
    >
      <header className="profile-view__header">
        {isSafeResourceUrl(profile.headerUrl) ? (
          <img alt="" className="profile-view__banner" src={profile.headerUrl} />
        ) : null}
        {isSafeResourceUrl(profile.avatarUrl) ? (
          <img
            alt={labels.avatar(profile.displayName)}
            className="profile-view__avatar"
            src={profile.avatarUrl}
          />
        ) : null}
        <h1>{profile.displayName}</h1>
        <p>{profile.handle}</p>
        {profile.bot ? <p>{labels.bot}</p> : null}
        {profile.locked ? <p>{labels.locked}</p> : null}
        <ProfileCounts labels={labels} profile={profile} />
        <FollowControl
          capability={followCapability}
          labels={labels}
          mutationPending={relationshipMutation.isPending}
          onToggle={() => {
            if (relationship !== undefined) {
              relationshipMutation.mutate({ id, following: relationship.following });
            }
          }}
          relationship={relationship}
          reasonId={relationshipReasonId}
        />
        {relationshipMutation.error === null ? null : (
          <p role="alert">{errorMessage(relationshipMutation.error, labels.failed)}</p>
        )}
      </header>
      {profile.bioHtml === undefined ? null : <SafeHtml html={profile.bioHtml} />}
      {profile.fields.length === 0 ? null : (
        <dl aria-label={labels.fields}>
          {profile.fields.map((field) => (
            <div key={`${field.name}\u0000${field.valueHtml}`}>
              <dt>{field.name}</dt>
              <dd>
                <SafeHtml html={field.valueHtml} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {posts.length === 0 ? (
        <p aria-live="polite">{labels.emptyPosts}</p>
      ) : (
        <ol className="content-list profile-view__posts">
          {posts.map((post) => (
            <li key={post.ref.id}>
              {renderPost === undefined ? <PostCard post={toPostCard(post)} /> : renderPost(post)}
            </li>
          ))}
        </ol>
      )}
      {query.hasNextPage ? (
        <button
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          type="button"
        >
          {query.isFetchingNextPage ? labels.loadingMore : labels.loadMore}
        </button>
      ) : null}
      <p aria-live="polite">{query.isFetchingNextPage ? labels.loadingMore : ""}</p>
    </article>
  );
}

function FollowControl({
  capability,
  relationship,
  mutationPending,
  onToggle,
  labels,
  reasonId,
}: {
  readonly capability: FollowCapability;
  readonly relationship: ProfileRelationship | undefined;
  readonly mutationPending: boolean;
  readonly onToggle: () => void;
  readonly labels: ProfileLabels;
  readonly reasonId: string;
}): ReactElement {
  if (capability.status !== "supported" || relationship === undefined) {
    const reason = nonBlankReason(capability.reason) ?? labels.relationshipUnavailable;
    const label = relationship?.following === true ? labels.unfollow : labels.follow;
    return (
      <>
        <button aria-describedby={reasonId} disabled type="button">
          {label}
        </button>
        <p id={reasonId}>{reason}</p>
      </>
    );
  }
  return (
    <button disabled={mutationPending} onClick={onToggle} type="button">
      {relationship.following ? labels.unfollow : labels.follow}
    </button>
  );
}

function nonBlankReason(reason: string | null): string | undefined {
  return reason === null || reason.trim() === "" ? undefined : reason;
}

function ProfileCounts({
  profile,
  labels,
}: {
  readonly profile: Profile;
  readonly labels: ProfileLabels;
}): ReactElement {
  return (
    <dl className="profile-view__counts">
      {profile.followersCount === undefined ? null : (
        <div>
          <dt>{labels.followers}</dt>
          <dd>{profile.followersCount}</dd>
        </div>
      )}
      {profile.followingCount === undefined ? null : (
        <div>
          <dt>{labels.following}</dt>
          <dd>{profile.followingCount}</dd>
        </div>
      )}
      {profile.postsCount === undefined ? null : (
        <div>
          <dt>{labels.postsCount}</dt>
          <dd>{profile.postsCount}</dd>
        </div>
      )}
    </dl>
  );
}

function toPostCard(post: ProfilePost): PostCardViewModel {
  return {
    id: post.ref.id,
    author: {
      displayName: post.author.displayName,
      ...(post.author.avatarUrl === undefined ? {} : { avatarUrl: post.author.avatarUrl }),
      profileUrl: productRouteHref({ name: "profile", id: post.author.ref.id }),
    },
    contentHtml: post.contentHtml,
    createdAt: post.createdAt,
    ...(post.summary === undefined ? {} : { summary: post.summary }),
    sensitive: post.sensitive,
    media: post.media.map((media) => ({
      id: media.ref.id,
      kind: media.type === "gifv" ? "video" : media.type,
      url: media.url,
      ...(media.previewUrl === undefined ? {} : { previewUrl: media.previewUrl }),
      ...(media.description === undefined ? {} : { description: media.description }),
    })),
    ...(post.replyTo === undefined ? {} : { replyTo: relation(post.replyTo, "Reply") }),
    ...(post.quoteOf === undefined ? {} : { quoteOf: relation(post.quoteOf, "Quoted post") }),
    ...(post.boostOf === undefined ? {} : { boostOf: relation(post.boostOf, "Boosted post") }),
    counts: {
      replies: post.counts?.replies ?? 0,
      boosts: post.counts?.reblogs ?? 0,
      favourites: post.counts?.favourites ?? 0,
    },
  };
}

function relation(ref: ProfileEntityRef, label: string) {
  return { id: ref.id, label, href: productRouteHref({ name: "post", id: ref.id }) };
}

function isSafeResourceUrl(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function errorMessage(error: Error, fallback: string): string {
  return error.message.trim() === "" ? fallback : error.message;
}
