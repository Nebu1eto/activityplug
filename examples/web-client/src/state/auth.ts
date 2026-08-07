import { queryOptions } from "@tanstack/react-query";
import { atom } from "jotai";

import {
  type BrowserServerDetection,
  type BrowserAuthCompleteRequest,
  type BrowserAuthStartRequest,
  type BrowserAuthStartResponse,
  type BrowserSessionPayload,
  type SupportedAdapter,
} from "../api/contracts.js";

export type {
  BrowserAuthCompleteRequest,
  BrowserAuthStartRequest,
  BrowserAuthStartResponse,
  BrowserServerDetection,
  SupportedAdapter,
};

export type BrowserSession = BrowserSessionPayload;

/**
 * A browser-boundary facade. Every method returns the BFF response itself,
 * never a transport-specific data envelope.
 */
export interface AuthApi {
  readonly session: (signal?: AbortSignal) => Promise<BrowserSession>;
  readonly detectServer: (origin: string, signal?: AbortSignal) => Promise<BrowserServerDetection>;
  readonly startAuth: (input: BrowserAuthStartRequest) => Promise<BrowserAuthStartResponse>;
  readonly completeAuth: (input: BrowserAuthCompleteRequest) => Promise<BrowserSession>;
  readonly logout: () => Promise<unknown>;
  readonly setCsrfToken: (token: string) => void;
  readonly abortUnsafeRequests: () => void;
}

export type AuthTransition =
  | { readonly status: "idle" }
  | {
      readonly status: "starting";
      readonly kind: "oauth" | "emailChallenge" | "passkey";
    }
  | { readonly status: "completing"; readonly kind: "emailChallenge" | "passkey" }
  | { readonly status: "redirecting" }
  | { readonly status: "loggingOut" };

// Server session state deliberately remains outside Jotai.
export const authTransitionAtom = atom<AuthTransition>({ status: "idle" });

export const webSessionKey = ["browser", "session"] as const;

/**
 * Normalizes free-form server address input into an HTTP(S) origin. Input
 * without a scheme is treated as HTTPS. Mirrors `canonicalizeOrigin` in
 * `@activityplug/core`, which runs again on the server boundary.
 */
export function normalizeOriginInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return url.origin.toLowerCase();
}

export function sessionOptions(api: Pick<AuthApi, "session">) {
  return queryOptions({
    queryKey: webSessionKey,
    queryFn: ({ signal }) => api.session(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
