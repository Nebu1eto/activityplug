import { useEffect, useRef, type RefObject } from "react";

interface InfiniteScrollOptions {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => unknown;
}

export function useInfiniteScroll({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: InfiniteScrollOptions): RefObject<HTMLButtonElement | null> {
  const boundaryRef = useRef<HTMLButtonElement>(null);
  const hasNextPageRef = useRef(hasNextPage);
  const isFetchingRef = useRef(isFetchingNextPage);
  const loadRequestedRef = useRef(isFetchingNextPage);
  const onLoadMoreRef = useRef(onLoadMore);
  const wasFetchingRef = useRef(isFetchingNextPage);

  useEffect(() => {
    hasNextPageRef.current = hasNextPage;
    isFetchingRef.current = isFetchingNextPage;
    onLoadMoreRef.current = onLoadMore;
    if (wasFetchingRef.current && !isFetchingNextPage) loadRequestedRef.current = false;
    if (isFetchingNextPage) loadRequestedRef.current = true;
    wasFetchingRef.current = isFetchingNextPage;
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  useEffect(() => {
    const boundary = boundaryRef.current;
    if (!hasNextPage || boundary === null || typeof IntersectionObserver === "undefined") {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          hasNextPageRef.current &&
          !isFetchingRef.current &&
          !loadRequestedRef.current
        ) {
          loadRequestedRef.current = true;
          void onLoadMoreRef.current();
        }
      },
      { rootMargin: "0px 0px 200px 0px" },
    );
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [hasNextPage]);

  return boundaryRef;
}
