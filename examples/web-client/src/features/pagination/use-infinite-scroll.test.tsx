// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../../test/setup.js";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInfiniteScroll } from "./use-infinite-scroll.js";

describe("useInfiniteScroll", () => {
  let observer: FakeIntersectionObserver;

  beforeEach(() => {
    observer = new FakeIntersectionObserver();
    function IntersectionObserverMock(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ): FakeIntersectionObserver {
      observer.callback = callback;
      observer.options = options;
      return observer;
    }
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads on intersection and suppresses duplicate requests while fetching", () => {
    const onLoadMore = vi.fn();
    const view = render(<Fixture hasNextPage isFetchingNextPage={false} onLoadMore={onLoadMore} />);

    expect(observer.observed).toBe(screen.getByRole("button", { name: "Load more" }));
    expect(observer.options).toEqual({ rootMargin: "0px 0px 200px 0px" });
    observer.intersect();
    observer.intersect();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(<Fixture hasNextPage isFetchingNextPage onLoadMore={onLoadMore} />);
    observer.intersect();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(<Fixture hasNextPage isFetchingNextPage={false} onLoadMore={onLoadMore} />);
    observer.intersect();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("disconnects without loading when pagination is exhausted", () => {
    const onLoadMore = vi.fn();
    const view = render(<Fixture hasNextPage isFetchingNextPage={false} onLoadMore={onLoadMore} />);

    view.rerender(
      <Fixture hasNextPage={false} isFetchingNextPage={false} onLoadMore={onLoadMore} />,
    );
    expect(observer.disconnect).toHaveBeenCalledOnce();
    observer.intersect();
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("keeps the manual button usable when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const onLoadMore = vi.fn();
    const user = userEvent.setup();
    render(<Fixture hasNextPage isFetchingNextPage={false} onLoadMore={onLoadMore} />);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});

function Fixture({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
}): ReactElement {
  const ref = useInfiniteScroll({ hasNextPage, isFetchingNextPage, onLoadMore });
  return (
    <button onClick={onLoadMore} ref={ref} type="button">
      Load more
    </button>
  );
}

class FakeIntersectionObserver implements IntersectionObserver {
  callback: IntersectionObserverCallback = () => undefined;
  readonly disconnect = vi.fn();
  observed: Element | undefined;
  options: IntersectionObserverInit | undefined;
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];

  observe(element: Element): void {
    this.observed = element;
  }

  intersect(): void {
    this.callback(
      [
        {
          boundingClientRect: elementRect(),
          intersectionRatio: 1,
          intersectionRect: elementRect(),
          isIntersecting: true,
          rootBounds: null,
          target: this.observed ?? document.body,
          time: 0,
        },
      ],
      this,
    );
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(): void {}
}

function elementRect(): DOMRectReadOnly {
  return {
    bottom: 1,
    height: 1,
    left: 0,
    right: 1,
    top: 0,
    width: 1,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}
