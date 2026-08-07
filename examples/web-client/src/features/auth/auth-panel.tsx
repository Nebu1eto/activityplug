import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";

import { WebApiError } from "../../api/http.js";
import { useI18n } from "../../i18n/i18n.js";
import { LocaleControl } from "../../i18n/locale-control.js";
import { useSessionRecovery, type SessionRecovery } from "../../state/auth-recovery.js";
import {
  authTransitionAtom,
  normalizeOriginInput,
  sessionOptions,
  webSessionKey,
  type AuthApi,
  type BrowserAuthStartResponse,
  type SupportedAdapter,
} from "../../state/auth.js";
import { prepareActiveUploadCoordinatorsForLogout } from "../composer/uploads.js";

const adapterLabels: Readonly<Record<SupportedAdapter, string>> = {
  mastodon: "Mastodon",
  pleroma: "Pleroma",
  hollo: "Hollo",
  misskey: "Misskey",
  hackerspub: "HackersPub",
};

const callbackParameters = [
  "code",
  "error",
  "error_description",
  "state",
  "hackerspubToken",
  "hackerspubCode",
  "hackerspubState",
] as const;

export function removeAuthCallbackParameters(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const parameter of callbackParameters) {
    if (url.searchParams.has(parameter)) {
      url.searchParams.delete(parameter);
      changed = true;
    }
  }
  if (changed) {
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
}

removeAuthCallbackParameters();

export interface AuthPanelProps {
  readonly api: AuthApi;
  readonly navigate?: (url: string) => void;
  readonly recoverSession?: SessionRecovery;
  /** Standalone use includes the shared selector; the public shell owns it otherwise. */
  readonly showLocaleControl?: boolean;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

function expectStartKind<K extends BrowserAuthStartResponse["kind"]>(
  result: BrowserAuthStartResponse,
  kind: K,
  unexpectedMessage: string,
): Extract<BrowserAuthStartResponse, { readonly kind: K }> {
  if (result.kind !== kind) throw new Error(unexpectedMessage);
  return result as Extract<BrowserAuthStartResponse, { readonly kind: K }>;
}

export function AuthPanel({
  api,
  navigate = defaultNavigate,
  recoverSession,
  showLocaleControl = true,
}: AuthPanelProps): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const standaloneRecovery = useSessionRecovery(api);
  const recoverUnauthenticated = recoverSession ?? standaloneRecovery;
  const session = useQuery(sessionOptions(api));
  const [transition, setTransition] = useAtom(authTransitionAtom);
  const [address, setAddress] = useState("");
  const [detection, setDetection] = useState<{
    readonly origin: string;
    readonly adapter: SupportedAdapter;
  } | null>(null);
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState<{
    readonly kind: "emailChallenge" | "passkey";
    readonly id: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const startAttempt = useRef(0);
  const detectionController = useRef<AbortController | undefined>(undefined);
  const detectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const originId = useId();
  const emailId = useId();
  const codeId = useId();

  useEffect(() => {
    removeAuthCallbackParameters();
    return () => {
      detectionController.current?.abort();
      clearTimeout(detectionTimer.current);
    };
  }, []);

  const ready = session.isSuccess && transition.status === "idle";
  const identityInputsDisabled = transition.status !== "idle";
  const adapter = detection?.adapter;

  const requireDetection = (): { readonly origin: string; readonly adapter: SupportedAdapter } => {
    if (detection === null) throw new Error(t("auth.softwareDetectionFailed"));
    return detection;
  };

  const resetIdentityState = (): void => {
    startAttempt.current += 1;
    setChallenge(null);
    setCode("");
    setError(null);
  };

  const handleAddressChange = (value: string): void => {
    detectionController.current?.abort();
    clearTimeout(detectionTimer.current);
    setAddress(value);
    setDetection(null);
    resetIdentityState();
    const controller = new AbortController();
    detectionController.current = controller;
    const origin = normalizeOriginInput(value);
    if (origin === undefined) return;
    // Debounce so detection runs once the address settles, not per keystroke.
    detectionTimer.current = setTimeout(() => {
      if (controller !== detectionController.current) return;
      void api
        .detectServer(origin, controller.signal)
        .then((result) => {
          if (controller !== detectionController.current) return;
          setDetection({ origin: result.origin, adapter: result.adapter });
        })
        .catch((detectionError: unknown) => {
          if (controller !== detectionController.current) return;
          setError(
            detectionError instanceof WebApiError &&
              (detectionError.code === "NOT_FOUND" || detectionError.code === "UNSUPPORTED")
              ? detectionError.message
              : t("auth.softwareDetectionFailed"),
          );
        });
    }, 300);
  };

  const complete = async (input: Parameters<AuthApi["completeAuth"]>[0]): Promise<void> => {
    const authenticated = await api.completeAuth(input);
    queryClient.setQueryData(webSessionKey, authenticated);
  };

  const startOAuth = async (): Promise<void> => {
    const attempt = ++startAttempt.current;
    setError(null);
    setTransition({ status: "starting", kind: "oauth" });
    try {
      const result = expectStartKind(
        await api.startAuth({
          kind: "oauth",
          origin: requireDetection().origin,
          adapter: requireDetection().adapter,
          returnTo: currentReturnTo(),
        }),
        "oauth",
        t("auth.unexpectedStart"),
      );
      if (attempt !== startAttempt.current) return;
      setTransition({ status: "redirecting" });
      navigate(result.redirectUrl);
    } catch (caught) {
      if (attempt !== startAttempt.current) return;
      setError(errorMessage(caught, t("auth.callbackFailed")));
      setTransition({ status: "idle" });
    }
  };

  const startEmailChallenge = async (): Promise<void> => {
    const attempt = ++startAttempt.current;
    setError(null);
    setTransition({ status: "starting", kind: "emailChallenge" });
    try {
      const result = expectStartKind(
        await api.startAuth({
          kind: "emailChallenge",
          origin: requireDetection().origin,
          adapter: "hackerspub",
          email,
        }),
        "emailChallenge",
        t("auth.unexpectedStart"),
      );
      if (attempt !== startAttempt.current) return;
      setChallenge({ kind: "emailChallenge", id: result.challengeId });
      setTransition({ status: "idle" });
    } catch (caught) {
      if (attempt !== startAttempt.current) return;
      setError(errorMessage(caught, t("auth.callbackFailed")));
      setTransition({ status: "idle" });
    }
  };

  const startPasskey = async (): Promise<void> => {
    const attempt = ++startAttempt.current;
    setError(null);
    setTransition({ status: "starting", kind: "passkey" });
    try {
      const result = expectStartKind(
        await api.startAuth({
          kind: "passkey",
          origin: requireDetection().origin,
          adapter: "hackerspub",
          ...(email === "" ? {} : { email }),
        }),
        "passkey",
        t("auth.unexpectedStart"),
      );
      if (attempt !== startAttempt.current) return;
      setChallenge({ kind: "passkey", id: result.challengeId });
      const credential = await startAuthentication({
        // The BFF-owned DTO is structurally equivalent; this cast never transforms it.
        optionsJSON: result.options as unknown as PublicKeyCredentialRequestOptionsJSON,
      });
      if (attempt !== startAttempt.current) return;
      setTransition({ status: "completing", kind: "passkey" });
      await complete({ kind: "passkey", challengeId: result.challengeId, credential });
      if (attempt !== startAttempt.current) return;
      setChallenge(null);
      setTransition({ status: "idle" });
    } catch (caught) {
      if (attempt !== startAttempt.current) return;
      setError(errorMessage(caught, t("auth.callbackFailed")));
      setTransition({ status: "idle" });
    }
  };

  const handlePrimarySubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready) return;
    void (adapter === "hackerspub" ? startEmailChallenge() : startOAuth());
  };

  const handleEmailComplete = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready || challenge?.kind !== "emailChallenge") return;
    setError(null);
    setTransition({ status: "completing", kind: "emailChallenge" });
    const activeChallengeId = challenge.id;
    const activeCode = code;
    setCode("");
    void complete({ kind: "emailChallenge", challengeId: activeChallengeId, code: activeCode })
      .then(() => {
        setChallenge(null);
        setTransition({ status: "idle" });
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught, t("auth.callbackFailed")));
        setTransition({ status: "idle" });
      });
  };

  const logout = async (): Promise<void> => {
    setError(null);
    setTransition({ status: "loggingOut" });
    let logoutFailure: unknown;
    api.abortUnsafeRequests();
    await prepareActiveUploadCoordinatorsForLogout();
    try {
      await api.logout();
    } catch (caught) {
      logoutFailure = caught;
    }

    try {
      // An ambiguous network result must never leave stale private data in memory.
      await recoverUnauthenticated(
        new WebApiError("UNAUTHENTICATED", "The active session was cleared."),
        { forceRefresh: true },
      );
    } catch (refreshFailure) {
      setError(
        logoutFailure === undefined
          ? errorMessage(refreshFailure, t("auth.callbackFailed"))
          : t("auth.logoutRefreshFailed", {
              logoutError: errorMessage(logoutFailure, t("auth.callbackFailed")),
              refreshError: errorMessage(refreshFailure, t("auth.callbackFailed")),
            }),
      );
      setTransition({ status: "idle" });
      return;
    }
    if (logoutFailure !== undefined) {
      setError(
        t("auth.logoutUnconfirmed", {
          error: errorMessage(logoutFailure, t("auth.callbackFailed")),
        }),
      );
    }
    setTransition({ status: "idle" });
  };

  if (session.isPending) return <p role="status">{t("auth.loading")}</p>;

  if (session.isError) {
    return <p role="alert">{errorMessage(session.error, t("auth.callbackFailed"))}</p>;
  }

  if (session.data.authenticated) {
    return (
      <section aria-label={t("auth.account")} className="auth-panel auth-panel--account">
        <p>{session.data.account.displayName}</p>
        {error === null ? null : (
          <p className="form-message form-message--error" role="alert">
            {error}
          </p>
        )}
        <button disabled={transition.status !== "idle"} onClick={() => void logout()} type="button">
          {transition.status === "loggingOut" ? t("auth.loggingOut") : t("auth.logout")}
        </button>
      </section>
    );
  }

  return (
    <section aria-label={t("auth.signIn")} className="auth-panel auth-panel--sign-in">
      {showLocaleControl ? <LocaleControl /> : null}
      <form className="auth-panel__form" onSubmit={handlePrimarySubmit}>
        <label htmlFor={originId}>{t("auth.origin")}</label>
        <input
          autoComplete="url"
          disabled={identityInputsDisabled}
          id={originId}
          onChange={(event) => {
            if (identityInputsDisabled) return;
            handleAddressChange(event.currentTarget.value);
          }}
          required
          type="text"
          value={address}
        />

        {detection === null ? null : (
          <p className="form-message form-message--info" role="status">
            {t("auth.softwareDetected", { software: adapterLabels[detection.adapter] })}
          </p>
        )}

        {adapter === "hackerspub" ? (
          <>
            <label htmlFor={emailId}>{t("auth.email")}</label>
            <input
              autoComplete="email"
              disabled={identityInputsDisabled}
              id={emailId}
              onChange={(event) => {
                if (identityInputsDisabled) return;
                setEmail(event.currentTarget.value);
                resetIdentityState();
              }}
              required
              type="email"
              value={email}
            />
            <div className="form-actions">
              <button disabled={!ready || email.trim() === ""} type="submit">
                {t("auth.sendCode")}
              </button>
              <button
                disabled={!ready || detection === null}
                onClick={() => void startPasskey()}
                type="button"
              >
                {t("auth.passkey")}
              </button>
            </div>
          </>
        ) : (
          <button disabled={!ready || detection === null} type="submit">
            {t("auth.continue")}
          </button>
        )}
      </form>

      {challenge?.kind !== "emailChallenge" ? null : (
        <form className="auth-panel__form" onSubmit={handleEmailComplete}>
          <label htmlFor={codeId}>{t("auth.code")}</label>
          <input
            autoComplete="one-time-code"
            id={codeId}
            inputMode="numeric"
            onChange={(event) => setCode(event.currentTarget.value)}
            required
            value={code}
          />
          <button disabled={!ready || code === ""} type="submit">
            {t("auth.verifyCode")}
          </button>
        </form>
      )}

      {error === null ? null : (
        <p className="form-message form-message--error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function currentReturnTo(): string {
  const url = new URL(window.location.href);
  return `${url.origin}${url.pathname}${url.search}${url.hash}`;
}
