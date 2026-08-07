import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type ReactElement } from "react";

import { webKeys } from "../../api/client.js";
import { navigateProductHref, ProductLink, productRouteHref } from "../../routing/location.js";
import { InfiniteScrollButton } from "../pagination/infinite-scroll-button.js";
import { type CapabilityCollection, type ControlDecision } from "../posts/capability.js";
import { PostCard, type PostCardViewModel } from "../posts/post-card.js";
import { productInfiniteQueryMaxPages } from "../timeline/queries.js";

export type SearchType = "all" | "accounts" | "posts" | "hashtags";

export interface SearchEntityRef {
  readonly id: string;
  readonly type?: string;
  readonly adapter?: string;
  readonly origin?: string;
  readonly url?: string;
}

export interface SearchProfileSummary {
  readonly ref: SearchEntityRef;
  readonly username: string;
  readonly handle: string;
  readonly displayName: string;
  readonly url?: string;
  readonly avatarUrl?: string;
  readonly bot: boolean;
  readonly locked: boolean;
}

export interface SearchMedia {
  readonly ref: SearchEntityRef;
  readonly type: "image" | "video" | "audio" | "gifv" | "unknown";
  readonly url: string;
  readonly previewUrl?: string;
  readonly description?: string;
}

export interface SearchPost {
  readonly ref: SearchEntityRef;
  readonly author: SearchProfileSummary;
  readonly contentHtml: string;
  readonly createdAt: string;
  readonly sensitive: boolean;
  readonly summary?: string;
  readonly media: readonly SearchMedia[];
  readonly replyTo?: SearchEntityRef;
  readonly quoteOf?: SearchEntityRef;
  readonly boostOf?: SearchEntityRef;
  readonly counts?: {
    readonly replies?: number;
    readonly reblogs?: number;
    readonly favourites?: number;
  };
}

export interface SearchHashtag {
  readonly name: string;
  readonly url?: string;
  readonly history: readonly {
    readonly day: string;
    readonly uses?: number;
    readonly accounts?: number;
  }[];
}

export interface SearchResponse {
  readonly accounts: readonly SearchProfileSummary[];
  readonly posts: readonly SearchPost[];
  readonly hashtags: readonly SearchHashtag[];
  readonly pageInfo: { readonly nextCursor: string | null };
}

export interface SearchApi {
  readonly search: (
    query: string,
    type: SearchType,
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<SearchResponse>;
}

export interface SearchLabels {
  readonly label: string;
  readonly all: string;
  readonly accounts: string;
  readonly posts: string;
  readonly hashtags: string;
  readonly prompt: string;
  readonly empty: string;
  readonly loading: string;
  readonly failed: string;
  readonly loadMore: string;
  readonly loadingMore: string;
  readonly result: string;
  readonly results: string;
  readonly unsupported: string;
  readonly unknown: string;
}

export interface SearchViewProps {
  readonly api: SearchApi;
  readonly capabilities?: CapabilityCollection;
  readonly initialQuery?: string;
  readonly labels?: Partial<SearchLabels>;
  readonly renderPost?: (post: SearchPost) => ReactElement;
}

const defaultLabels: SearchLabels = {
  label: "Search posts, people, and hashtags",
  all: "All",
  accounts: "People",
  posts: "Posts",
  hashtags: "Hashtags",
  prompt: "Enter at least two characters.",
  empty: "No search results.",
  loading: "Searching…",
  failed: "Search could not be completed.",
  loadMore: "Load more results",
  loadingMore: "Loading more results",
  result: "result",
  results: "results",
  unsupported: "This search is not supported by the connected server.",
  unknown: "Support for this search could not be confirmed.",
};

export const searchQueryKey = (query: string, type: SearchType) => webKeys.search(query, type);

export function SearchView({
  api,
  capabilities,
  initialQuery = "",
  labels: labelOverrides,
  renderPost,
}: SearchViewProps): ReactElement {
  const labels = { ...defaultLabels, ...labelOverrides };
  const typeId = useId();
  const decisions = searchTypeDecisions(capabilities, labels);
  const fallbackType = firstAvailableSearchType(decisions);
  const initialNormalizedQuery = normalizeQuery(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState<SearchType>(() => fallbackType ?? "all");
  const [debouncedQuery, setDebouncedQuery] = useState(
    hasMinimumLength(initialNormalizedQuery) ? initialNormalizedQuery : "",
  );
  const normalizedQuery = normalizeQuery(query);
  const isShortQuery = !hasMinimumLength(normalizedQuery);
  const activeType = decisions[type].enabled ? type : fallbackType;
  const activeQuery = isShortQuery || activeType === null ? "" : debouncedQuery;

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (activeType !== null && type !== activeType) setType(activeType);
  }, [activeType, type]);

  useEffect(() => {
    if (!hasMinimumLength(normalizedQuery)) {
      setDebouncedQuery("");
      navigateProductHref(productRouteHref({ name: "search", query: normalizedQuery }), {
        replace: true,
      });
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(normalizedQuery);
      navigateProductHref(productRouteHref({ name: "search", query: normalizedQuery }), {
        replace: true,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery]);

  const search = useInfiniteQuery({
    queryKey: searchQueryKey(activeQuery, activeType ?? "all"),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (activeType === null) throw new Error("No supported search type is available.");
      return api.search(activeQuery, activeType, pageParam, signal);
    },
    getNextPageParam: (lastPage, allPages) =>
      allPages.length >= productInfiniteQueryMaxPages
        ? undefined
        : (lastPage.pageInfo.nextCursor ?? undefined),
    enabled: hasMinimumLength(activeQuery) && activeType !== null,
    retry: false,
  });
  const pages = search.data?.pages ?? [];
  const accounts = pages.flatMap((page) => page.accounts);
  const posts = pages.flatMap((page) => page.posts);
  const hashtags = pages.flatMap((page) => page.hashtags);
  const resultCount = accounts.length + posts.length + hashtags.length;
  return (
    <section aria-busy={search.isPending && !isShortQuery} className="search-view">
      <label>
        {labels.label}
        <input
          onChange={(event) => setQuery(event.currentTarget.value)}
          type="search"
          value={query}
        />
      </label>
      <fieldset className="search-view__filters">
        <legend>{labels.label}</legend>
        {(["all", "accounts", "posts", "hashtags"] as const).map((value) => {
          const decision = decisions[value];
          const reasonId = `${typeId}-${value}`;
          return (
            <div className="search-view__filter" key={value}>
              <label>
                <input
                  aria-describedby={decision.enabled ? undefined : reasonId}
                  checked={type === value}
                  disabled={!decision.enabled}
                  name="search-type"
                  onChange={() => setType(value)}
                  type="radio"
                  value={value}
                />
                {labels[value]}
              </label>
              {decision.enabled ? null : (
                <span className="control-reason" id={reasonId}>
                  {decision.reason}
                </span>
              )}
            </div>
          );
        })}
      </fieldset>
      {isShortQuery ? <p>{labels.prompt}</p> : null}
      {!isShortQuery && search.isPending ? <p>{labels.loading}</p> : null}
      {search.error === null ? null : (
        <p role="alert">{errorMessage(search.error, labels.failed)}</p>
      )}
      {!isShortQuery && !search.isPending && search.error === null && resultCount === 0 ? (
        <p>{labels.empty}</p>
      ) : null}
      {accounts.length === 0 ? null : (
        <ul aria-label={labels.accounts} className="content-list search-view__accounts">
          {accounts.map((account) => (
            <li key={account.ref.id}>
              <ProductLink
                aria-label={account.displayName}
                className="search-view__account"
                href={productRouteHref({ name: "profile", id: account.ref.id })}
              >
                {isSafeResourceUrl(account.avatarUrl) ? (
                  <img alt="" className="search-view__avatar" src={account.avatarUrl} />
                ) : null}
                <span>{account.displayName}</span>
                <span>{account.handle}</span>
              </ProductLink>
            </li>
          ))}
        </ul>
      )}
      {posts.length === 0 ? null : (
        <ol aria-label={labels.posts} className="content-list">
          {posts.map((post) => (
            <li key={post.ref.id}>
              {renderPost === undefined ? <PostCard post={toPostCard(post)} /> : renderPost(post)}
            </li>
          ))}
        </ol>
      )}
      {hashtags.length === 0 ? null : (
        <ul aria-label={labels.hashtags} className="content-list search-view__hashtags">
          {hashtags.map((hashtag) => (
            <li key={hashtag.name}>{renderHashtag(hashtag)}</li>
          ))}
        </ul>
      )}
      <InfiniteScrollButton
        hasNextPage={search.hasNextPage}
        isFetchingNextPage={search.isFetchingNextPage}
        onLoadMore={search.fetchNextPage}
      >
        {search.isFetchingNextPage ? labels.loadingMore : labels.loadMore}
      </InfiniteScrollButton>
      <p aria-live="polite" role="status">
        {isShortQuery || search.isPending
          ? ""
          : `${resultCount} ${resultCount === 1 ? labels.result : labels.results}`}
      </p>
    </section>
  );
}

const concreteSearchTypes = ["accounts", "posts", "hashtags"] as const;

function searchTypeDecisions(
  capabilities: CapabilityCollection | undefined,
  labels: SearchLabels,
): Readonly<Record<SearchType, ControlDecision>> {
  const entries = capabilityEntries(capabilities);
  const advertisesSearchCapabilities = entries.some((entry) => entry.name.startsWith("search."));
  const byType = Object.fromEntries(
    concreteSearchTypes.map((type) => [
      type,
      searchTypeDecision(type, entries, advertisesSearchCapabilities, labels),
    ]),
  ) as Readonly<Record<Exclude<SearchType, "all">, ControlDecision>>;
  const firstUnavailable = concreteSearchTypes
    .map((type) => byType[type])
    .find((decision) => !decision.enabled);

  return {
    all: firstUnavailable ?? { enabled: true },
    ...byType,
  };
}

function searchTypeDecision(
  type: Exclude<SearchType, "all">,
  entries: readonly {
    readonly name: string;
    readonly reason?: string | null;
    readonly status: string;
  }[],
  advertisesSearchCapabilities: boolean,
  labels: SearchLabels,
): ControlDecision {
  if (!advertisesSearchCapabilities) return { enabled: true };
  const capability = entries.find((entry) => entry.name === `search.${type}`);
  if (capability?.status === "supported") return { enabled: true };
  return {
    enabled: false,
    reason:
      nonBlankReason(capability?.reason) ??
      (capability?.status === "unsupported" ? labels.unsupported : labels.unknown),
  };
}

function capabilityEntries(
  capabilities: CapabilityCollection | undefined,
): readonly { readonly name: string; readonly reason?: string | null; readonly status: string }[] {
  if (capabilities === undefined) return [];
  return "capabilities" in capabilities ? capabilities.capabilities : capabilities;
}

function firstAvailableSearchType(
  decisions: Readonly<Record<SearchType, ControlDecision>>,
): SearchType | null {
  return (
    (["all", "accounts", "posts", "hashtags"] as const).find((type) => decisions[type].enabled) ??
    null
  );
}

function nonBlankReason(reason: string | null | undefined): string | undefined {
  return reason === null || reason === undefined || reason.trim() === "" ? undefined : reason;
}

function renderHashtag(hashtag: SearchHashtag): ReactElement {
  const label = `#${hashtag.name}`;
  if (isSafeExternalUrl(hashtag.url)) {
    return (
      <a href={hashtag.url} rel="nofollow noopener noreferrer" target="_blank">
        {label}
      </a>
    );
  }
  return (
    <ProductLink href={productRouteHref({ name: "search", query: label })}>{label}</ProductLink>
  );
}

function normalizeQuery(value: string): string {
  return value.trim();
}

function hasMinimumLength(value: string): boolean {
  return [...value].length >= 2;
}

function isSafeExternalUrl(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isSafeResourceUrl(value: string | undefined): value is string {
  return isSafeExternalUrl(value);
}

function toPostCard(post: SearchPost): PostCardViewModel {
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

function relation(ref: SearchEntityRef, label: string) {
  return { id: ref.id, label, href: productRouteHref({ name: "post", id: ref.id }) };
}

function errorMessage(error: Error, fallback: string): string {
  return error.message.trim() === "" ? fallback : error.message;
}
