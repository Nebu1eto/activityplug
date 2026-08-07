import { type ReactElement, type ReactNode } from "react";

import { useInfiniteScroll } from "./use-infinite-scroll.js";

interface InfiniteScrollButtonProps {
  readonly children: ReactNode;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => unknown;
}

export function InfiniteScrollButton({
  children,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: InfiniteScrollButtonProps): ReactElement {
  const boundaryRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
  });

  return (
    <button
      disabled={!hasNextPage || isFetchingNextPage}
      hidden={!hasNextPage}
      onClick={() => void onLoadMore()}
      ref={boundaryRef}
      type="button"
    >
      {children}
    </button>
  );
}
