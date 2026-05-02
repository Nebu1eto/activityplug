import { removeStorageKeyPrefix } from "./storage.js";

export interface PendingHackersPubLogin {
  readonly origin: string;
  readonly token: string;
  readonly state: string;
}

export type HackersPubCallback =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "invalid";
      readonly message: string;
      readonly pendingLogin?: PendingHackersPubLogin;
    }
  | {
      readonly kind: "matched";
      readonly code: string;
      readonly pendingLogin: PendingHackersPubLogin;
    };

const oauthStateKey = "activityplug.web-client.startedAuth";
const oauthStateKeyPrefix = "activityplug.web-client.startedAuth.";
const hackersPubStateKeyPrefix = "activityplug.web-client.hackerspubLogin.";

export function storeStartedAuthState(storage: Storage, state: string, serialized: string): void {
  storage.setItem(oauthStateKey, serialized);
  storage.setItem(oauthStateSpecificKey(state), serialized);
}

export function storedStartedAuthState(storage: Storage, state: string | null): string | null {
  if (state !== null) {
    const storedByState = storage.getItem(oauthStateSpecificKey(state));
    if (storedByState !== null) return storedByState;
  }
  return storage.getItem(oauthStateKey);
}

export function clearStoredAuthState(storage: Storage, state?: string): void {
  storage.removeItem(oauthStateKey);
  if (state === undefined) {
    removeStorageKeyPrefix(storage, oauthStateKeyPrefix);
    return;
  }
  storage.removeItem(oauthStateSpecificKey(state));
}

export function createHackersPubVerifyUrl(input: {
  readonly callbackUrl: string;
  readonly origin: string;
  readonly state: string;
}): string {
  return `${input.callbackUrl}?hackerspubOrigin=${encodeURIComponent(
    input.origin,
  )}&hackerspubState=${encodeURIComponent(input.state)}&hackerspubToken={token}&hackerspubCode={code}`;
}

export function storePendingHackersPubLogin(storage: Storage, login: PendingHackersPubLogin): void {
  storage.setItem(hackersPubStateKey(login.state), JSON.stringify(login));
}

export function resolveHackersPubCallback(storage: Storage, url: URL): HackersPubCallback {
  const token = url.searchParams.get("hackerspubToken");
  const code = url.searchParams.get("hackerspubCode");
  if (token === null && code === null) return { kind: "none" };
  if (token === null || code === null) {
    return { kind: "invalid", message: "HackersPub login callback is incomplete." };
  }
  const state = url.searchParams.get("hackerspubState");
  const pendingLogin = pendingHackersPubLogin(storage, state);
  if (pendingLogin === null || pendingLogin.token !== token) {
    return {
      kind: "invalid",
      message: "No matching HackersPub login challenge was found for this callback.",
      ...(pendingLogin === null ? {} : { pendingLogin }),
    };
  }
  return { kind: "matched", code, pendingLogin };
}

export function clearPendingHackersPubLogin(storage: Storage, state?: string): void {
  if (state === undefined) {
    removeStorageKeyPrefix(storage, hackersPubStateKeyPrefix);
    return;
  }
  storage.removeItem(hackersPubStateKey(state));
}

function pendingHackersPubLogin(
  storage: Storage,
  state: string | null,
): PendingHackersPubLogin | null {
  if (state === null) return null;
  const stored = storage.getItem(hackersPubStateKey(state));
  if (stored === null) return null;
  return JSON.parse(stored) as PendingHackersPubLogin;
}

function oauthStateSpecificKey(state: string): string {
  return `${oauthStateKeyPrefix}${state}`;
}

function hackersPubStateKey(state: string): string {
  return `${hackersPubStateKeyPrefix}${state}`;
}
