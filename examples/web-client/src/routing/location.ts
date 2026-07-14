import {
  createElement,
  type AnchorHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  useMemo,
  useSyncExternalStore,
} from "react";

export type ProductLocation =
  | { readonly name: "home" }
  | { readonly name: "local" }
  | { readonly name: "federated" }
  | { readonly name: "search"; readonly query: string }
  | { readonly name: "profile"; readonly id: string | null }
  | { readonly name: "post"; readonly id: string | null }
  | { readonly name: "notFound"; readonly pathname: string };

export type ProductRouteTarget =
  | { readonly name: "home" | "local" | "federated" }
  | { readonly name: "search"; readonly query?: string }
  | { readonly name: "profile" | "post"; readonly id: string };

export interface HistoryNavigationIntent {
  readonly href: string;
  readonly button: number;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly defaultPrevented?: boolean;
  readonly target?: string;
  readonly download?: boolean;
}

export interface ProductLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  readonly href: string;
}

export function parseProductLocation(url: URL): ProductLocation {
  switch (url.pathname) {
    case "/":
      return { name: "home" };
    case "/local":
      return { name: "local" };
    case "/federated":
      return { name: "federated" };
    case "/search":
      return { name: "search", query: url.searchParams.get("q") ?? "" };
    case "/profile":
      return { name: "profile", id: nonEmptyQueryValue(url.searchParams.get("id")) };
    case "/post":
      return { name: "post", id: nonEmptyQueryValue(url.searchParams.get("id")) };
    default:
      return { name: "notFound", pathname: url.pathname };
  }
}

export function productRouteHref(target: ProductRouteTarget): string {
  switch (target.name) {
    case "home":
      return "/";
    case "local":
      return "/local";
    case "federated":
      return "/federated";
    case "search":
      return withQuery("/search", "q", target.query);
    case "profile":
      return withQuery("/profile", "id", target.id);
    case "post":
      return withQuery("/post", "id", target.id);
  }
  throw new TypeError("Unsupported product route target.");
}

export function useProductLocation(): ProductLocation {
  const href = useSyncExternalStore(subscribeToHistory, currentHref, serverHref);
  return useMemo(() => parseProductLocation(new URL(href)), [href]);
}

export function shouldUseHistoryNavigation(
  intent: HistoryNavigationIntent,
  currentOrigin = browserOrigin(),
): boolean {
  if (
    intent.defaultPrevented === true ||
    intent.button !== 0 ||
    intent.altKey === true ||
    intent.ctrlKey === true ||
    intent.metaKey === true ||
    intent.shiftKey === true ||
    intent.download === true ||
    (intent.target !== undefined && intent.target !== "" && intent.target !== "_self") ||
    currentOrigin === null
  ) {
    return false;
  }

  try {
    return new URL(intent.href, `${currentOrigin}/`).origin === currentOrigin;
  } catch {
    return false;
  }
}

export function navigateProductHref(
  href: string,
  options: { readonly replace?: boolean } = {},
): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return false;

  const nextHref = `${url.pathname}${url.search}${url.hash}`;
  if (options.replace === true) {
    window.history.replaceState(null, "", nextHref);
  } else {
    window.history.pushState(null, "", nextHref);
  }
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  return true;
}

export function ProductLink({ href, onClick, ...props }: ProductLinkProps): ReactElement {
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    const anchor = event.currentTarget;
    if (
      !shouldUseHistoryNavigation({
        href: anchor.href,
        button: event.button,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        target: anchor.target,
        download: anchor.hasAttribute("download"),
      })
    ) {
      return;
    }

    event.preventDefault();
    navigateProductHref(anchor.href);
  };

  return createElement("a", { ...props, href, onClick: handleClick });
}

function withQuery(pathname: string, key: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) return pathname;
  const search = new URLSearchParams();
  search.set(key, value);
  return `${pathname}?${search.toString()}`;
}

function nonEmptyQueryValue(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}

function subscribeToHistory(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function currentHref(): string {
  return typeof window === "undefined" ? serverHref() : window.location.href;
}

function serverHref(): string {
  return "http://localhost/";
}

function browserOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}
