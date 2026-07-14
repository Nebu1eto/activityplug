import { queryOptions } from "@tanstack/react-query";
import { atom } from "jotai";

import {
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
  SupportedAdapter,
};

export type BrowserSession = BrowserSessionPayload;

/**
 * A browser-boundary facade. Every method returns the BFF response itself,
 * never a transport-specific data envelope.
 */
export interface AuthApi {
  readonly session: (signal?: AbortSignal) => Promise<BrowserSession>;
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

export function sessionOptions(api: Pick<AuthApi, "session">) {
  return queryOptions({
    queryKey: webSessionKey,
    queryFn: ({ signal }) => api.session(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
