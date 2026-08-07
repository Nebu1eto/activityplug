import { useInfiniteQuery } from "@tanstack/react-query";
import { type ReactElement } from "react";

import { ProductLink, productRouteHref } from "../../routing/location.js";
import { InfiniteScrollButton } from "../pagination/infinite-scroll-button.js";
import { PostCard, type PostCardViewModel } from "../posts/post-card.js";
import {
  timelineOptions,
  type TimelineApi,
  type TimelineKind,
  type TimelinePost,
} from "./queries.js";

export interface TimelineLabels {
  readonly navigation: string;
  readonly home: string;
  readonly local: string;
  readonly federated: string;
  readonly loading: string;
  readonly loadingMore: string;
  readonly loadMore: string;
  readonly retry: string;
  readonly empty: string;
  readonly failed: string;
  readonly replyTo: string;
  readonly quoteOf: string;
  readonly boostOf: string;
}

const defaultLabels: TimelineLabels = {
  navigation: "Timelines",
  home: "Home",
  local: "Local",
  federated: "Federated",
  loading: "Loading timeline",
  loadingMore: "Loading more posts",
  loadMore: "Load more posts",
  retry: "Retry timeline",
  empty: "No posts are available yet.",
  failed: "The timeline could not be loaded.",
  replyTo: "Reply",
  quoteOf: "Quoted post",
  boostOf: "Boosted post",
};

export interface TimelineProps {
  readonly api: TimelineApi;
  readonly kind: TimelineKind;
  readonly labels?: Partial<TimelineLabels>;
  readonly renderPost?: (post: TimelinePost) => ReactElement;
  readonly showNavigation?: boolean;
}

export function Timeline({
  api,
  kind,
  labels: labelOverrides,
  renderPost,
  showNavigation = true,
}: TimelineProps): ReactElement {
  const labels = { ...defaultLabels, ...labelOverrides };
  const query = useInfiniteQuery(timelineOptions(api, kind));
  const posts = query.data?.pages.flatMap((page) => page.posts) ?? [];
  return (
    <section aria-busy={query.isPending || query.isFetchingNextPage} className="timeline">
      {showNavigation ? <TimelineNavigation kind={kind} labels={labels} /> : null}
      {query.isPending ? <TimelineSkeleton label={labels.loading} /> : null}
      {query.error === null ? null : (
        <div>
          <p role="alert">{errorMessage(query.error, labels.failed)}</p>
          <button
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
            type="button"
          >
            {labels.retry}
          </button>
        </div>
      )}
      {!query.isPending && query.error === null && posts.length === 0 ? (
        <p>{labels.empty}</p>
      ) : null}
      {posts.length === 0 ? null : (
        <ol className="content-list timeline__list">
          {posts.map((post) => (
            <li key={post.ref.id}>
              {renderPost === undefined ? (
                <PostCard post={toPostCard(post, labels)} />
              ) : (
                renderPost(post)
              )}
            </li>
          ))}
        </ol>
      )}
      <InfiniteScrollButton
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        onLoadMore={query.fetchNextPage}
      >
        {labels.loadMore}
      </InfiniteScrollButton>
      <p aria-live="polite">{query.isFetchingNextPage ? labels.loadingMore : ""}</p>
    </section>
  );
}

function TimelineNavigation({
  kind,
  labels,
}: {
  readonly kind: TimelineKind;
  readonly labels: TimelineLabels;
}): ReactElement {
  const links: readonly {
    readonly kind: TimelineKind;
    readonly href: string;
    readonly label: string;
  }[] = [
    { kind: "home", href: "/", label: labels.home },
    { kind: "local", href: "/local", label: labels.local },
    { kind: "federated", href: "/federated", label: labels.federated },
  ];
  return (
    <nav aria-label={labels.navigation} className="timeline__navigation">
      {links.map((link) => (
        <ProductLink
          aria-current={link.kind === kind ? "page" : undefined}
          href={link.href}
          key={link.kind}
        >
          {link.label}
        </ProductLink>
      ))}
    </nav>
  );
}

function TimelineSkeleton({ label }: { readonly label: string }): ReactElement {
  return (
    <div aria-label={label} role="status">
      <span aria-hidden="true">•••</span>
      <span>{label}</span>
    </div>
  );
}

function toPostCard(post: TimelinePost, labels: TimelineLabels): PostCardViewModel {
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
    ...(post.replyTo === undefined ? {} : { replyTo: relation(post.replyTo, labels.replyTo) }),
    ...(post.quoteOf === undefined ? {} : { quoteOf: relation(post.quoteOf, labels.quoteOf) }),
    ...(post.boostOf === undefined ? {} : { boostOf: relation(post.boostOf, labels.boostOf) }),
    counts: {
      replies: post.counts?.replies ?? 0,
      boosts: post.counts?.reblogs ?? 0,
      favourites: post.counts?.favourites ?? 0,
    },
  };
}

function relation(ref: { readonly id: string; readonly url?: string }, label: string) {
  return {
    id: ref.id,
    label,
    href: productRouteHref({ name: "post", id: ref.id }),
  };
}

function errorMessage(error: Error, fallback: string): string {
  return error.message.trim() === "" ? fallback : error.message;
}
