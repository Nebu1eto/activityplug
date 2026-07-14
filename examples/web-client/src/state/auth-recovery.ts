import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type createStore, useStore } from "jotai";
import { useEffect, useMemo } from "react";

import { type WebApiError } from "../api/http.js";
import { disposeActiveUploadCoordinators } from "../features/composer/uploads.js";
import { sessionOptions, webSessionKey, type AuthApi, type BrowserSession } from "./auth.js";
import { resetComposerState } from "./composer.js";

type Store = ReturnType<typeof createStore>;

interface SessionRecoveryDependencies {
  readonly api: AuthApi;
  readonly queryClient: QueryClient;
  readonly store: Store;
}

interface QueryErrorEvent {
  readonly type: "updated";
  readonly action: { readonly type: "error"; readonly error: unknown };
  readonly query: { readonly queryKey: readonly unknown[] };
}

interface MutationErrorEvent {
  readonly type: "updated";
  readonly action: { readonly type: "error"; readonly error: unknown };
}

export interface SessionRecoveryOptions {
  /** Starts a new session refresh even when an earlier recovery is still pending. */
  readonly forceRefresh?: boolean;
}

export type SessionRecovery = (error: unknown, options?: SessionRecoveryOptions) => Promise<void>;

/**
 * Verifies an authentication error against the browser session before claiming
 * the one-way private-to-anonymous boundary. The session query is intentionally
 * not observed, which prevents a failed refresh from recursively scheduling
 * more refreshes.
 */
export function createSessionRecovery({
  api,
  queryClient,
  store,
}: SessionRecoveryDependencies): SessionRecovery {
  let pending: Promise<void> | undefined;
  let boundaryClaimed = false;
  let recoveryGeneration = 0;

  return async (error, options = {}): Promise<void> => {
    if (!isUnauthenticatedError(error)) return;
    const forceRefresh = options.forceRefresh === true;
    if (!forceRefresh && pending !== undefined) return pending;
    const session = queryClient.getQueryData<BrowserSession>(webSessionKey);
    if (!forceRefresh && session?.authenticated === false) return;
    if (session?.authenticated === true) boundaryClaimed = false;
    if (!forceRefresh && boundaryClaimed) return;
    boundaryClaimed = true;
    const generation = ++recoveryGeneration;

    api.abortUnsafeRequests();
    api.setCsrfToken("");
    const recovery = (async () => {
      await queryClient.cancelQueries();
      try {
        await refreshSession(api, queryClient);
      } catch (refreshError) {
        if (generation !== recoveryGeneration) return;
        clearPrivateSessionState(queryClient, store);
        throw refreshError;
      }
      if (generation !== recoveryGeneration) return;
      const refreshed = queryClient.getQueryData<BrowserSession>(webSessionKey);
      if (refreshed?.authenticated === true) {
        boundaryClaimed = false;
        return;
      }
      clearPrivateSessionState(queryClient, store);
    })().finally(() => {
      if (pending === recovery) pending = undefined;
    });
    pending = recovery;
    return recovery;
  };
}

function clearPrivateSessionState(queryClient: QueryClient, store: Store): void {
  void disposeActiveUploadCoordinators();
  resetComposerState(store);
  queryClient.removeQueries({ predicate: (query) => !isSessionQuery(query.queryKey) });
  queryClient.getMutationCache().clear();
}

async function refreshSession(api: AuthApi, queryClient: QueryClient): Promise<void> {
  const existing = queryClient.getQueryCache().find({ queryKey: webSessionKey, exact: true });
  if (existing?.isActive() === true) {
    await queryClient.resetQueries(
      { queryKey: webSessionKey, exact: true },
      { throwOnError: true },
    );
    return;
  }
  queryClient.removeQueries({ queryKey: webSessionKey, exact: true });
  await queryClient.fetchQuery(sessionOptions(api));
}

/** Watches every private query and mutation through React Query's shared caches. */
export function useUnauthenticatedRecovery(api: AuthApi): SessionRecovery {
  const queryClient = useQueryClient();
  const recover = useSessionRecovery(api);

  useEffect(() => {
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (!isQueryErrorEvent(event) || isSessionQuery(event.query.queryKey)) return;
      void recover(event.action.error).catch(() => undefined);
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (!isMutationErrorEvent(event)) return;
      void recover(event.action.error).catch(() => undefined);
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient, recover]);

  return recover;
}

/** Returns the shared account-boundary transition without attaching observers. */
export function useSessionRecovery(api: AuthApi): SessionRecovery {
  const queryClient = useQueryClient();
  const store = useStore();
  return useMemo(
    () => createSessionRecovery({ api, queryClient, store }),
    [api, queryClient, store],
  );
}

export function isUnauthenticatedError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "WebApiError") return false;
  const webError = error as WebApiError;
  return webError.status === 401 || webError.code === "UNAUTHENTICATED";
}

function isSessionQuery(queryKey: readonly unknown[]): boolean {
  return (
    queryKey.length === webSessionKey.length &&
    queryKey.every((part, index) => part === webSessionKey[index])
  );
}

function isQueryErrorEvent(event: unknown): event is QueryErrorEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "updated" &&
    "action" in event &&
    typeof event.action === "object" &&
    event.action !== null &&
    "type" in event.action &&
    event.action.type === "error" &&
    "error" in event.action &&
    "query" in event &&
    typeof event.query === "object" &&
    event.query !== null &&
    "queryKey" in event.query &&
    Array.isArray(event.query.queryKey)
  );
}

function isMutationErrorEvent(event: unknown): event is MutationErrorEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "updated" &&
    "action" in event &&
    typeof event.action === "object" &&
    event.action !== null &&
    "type" in event.action &&
    event.action.type === "error" &&
    "error" in event.action
  );
}
