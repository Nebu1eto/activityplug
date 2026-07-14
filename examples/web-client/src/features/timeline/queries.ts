import { infiniteQueryOptions } from "@tanstack/react-query";

import { productPageSize, webKeys } from "../../api/client.js";

export type TimelineKind = "home" | "local" | "federated";

/** Retain at most ten product pages, or 200 items at the shared page size. */
export const productInfiniteQueryMaxPages = 10;
export const productInfiniteQueryMaxItems = productInfiniteQueryMaxPages * productPageSize;

export interface TimelineEntityRef {
  readonly id: string;
  readonly url?: string;
}

export interface TimelineAuthor {
  readonly ref: TimelineEntityRef;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly url?: string;
}

export interface TimelineMedia {
  readonly ref: TimelineEntityRef;
  readonly type: "image" | "video" | "audio" | "gifv" | "unknown";
  readonly url: string;
  readonly previewUrl?: string;
  readonly description?: string;
}

export interface TimelinePost {
  readonly ref: TimelineEntityRef;
  readonly author: TimelineAuthor;
  readonly contentHtml: string;
  readonly createdAt: string;
  readonly summary?: string;
  readonly sensitive: boolean;
  readonly media: readonly TimelineMedia[];
  readonly replyTo?: TimelineEntityRef;
  readonly quoteOf?: TimelineEntityRef;
  readonly boostOf?: TimelineEntityRef;
  readonly counts?: {
    readonly replies?: number;
    readonly reblogs?: number;
    readonly favourites?: number;
  };
}

export interface TimelinePage {
  readonly posts: readonly TimelinePost[];
  readonly pageInfo: { readonly nextCursor: string | null };
}

export interface TimelineApi {
  readonly timeline: (
    kind: TimelineKind,
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<TimelinePage>;
}

export const timelineQueryKey = (kind: TimelineKind) => webKeys.timeline(kind);

export function timelineOptions(api: TimelineApi, kind: TimelineKind) {
  return infiniteQueryOptions({
    queryKey: timelineQueryKey(kind),
    initialPageParam: undefined as string | undefined,
    // Cursors are opaque upstream tokens and must never be decoded or derived from post IDs.
    queryFn: ({ pageParam, signal }) => api.timeline(kind, pageParam, signal),
    getNextPageParam: (lastPage, allPages) =>
      allPages.length >= productInfiniteQueryMaxPages
        ? undefined
        : (lastPage.pageInfo.nextCursor ?? undefined),
    retry: false,
  });
}
