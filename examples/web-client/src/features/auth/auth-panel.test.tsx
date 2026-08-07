// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../../test/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type PropsWithChildren, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WebApiError } from "../../api/http.js";
import {
  authTransitionAtom,
  webSessionKey,
  type AuthApi,
  type BrowserSession,
  type BrowserServerDetection,
} from "../../state/auth.js";
import { composerAtom } from "../../state/composer.js";
import { localeAtom, type Locale } from "../../state/locale.js";
import { registerUploadCoordinator, UploadCoordinator } from "../composer/uploads.js";
import { AuthPanel } from "./auth-panel.js";

const { startAuthentication } = vi.hoisted(() => ({ startAuthentication: vi.fn() }));

vi.mock("@simplewebauthn/browser", () => ({ startAuthentication }));

const anonymousSession: BrowserSession = {
  authenticated: false,
  csrfToken: "csrf-anonymous",
};

const authenticatedSession: BrowserSession = {
  authenticated: true,
  csrfToken: "csrf-authenticated",
  adapter: "pleroma",
  origin: "https://social.example",
  strategy: "oauth",
  account: {
    ref: { id: "account-1", type: "account", adapter: "pleroma", origin: "https://social.example" },
    username: "alice",
    handle: "alice",
    displayName: "Alice",
    bot: false,
    locked: false,
    fields: [],
  },
  capabilities: { capabilities: [] },
};

function apiFixture(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    session: vi.fn(async () => anonymousSession),
    detectServer: vi.fn(async (origin: string): Promise<BrowserServerDetection> => {
      const adapter = origin.includes("hackers") ? ("hackerspub" as const) : ("mastodon" as const);
      return { adapter, origin, software: adapter };
    }),
    startAuth: vi.fn(async () => ({
      kind: "oauth" as const,
      redirectUrl: "https://social.example/oauth",
    })),
    completeAuth: vi.fn(async () => authenticatedSession),
    logout: vi.fn(async () => undefined),
    setCsrfToken: vi.fn(),
    abortUnsafeRequests: vi.fn(),
    ...overrides,
  };
}

function renderPanel(
  api: AuthApi,
  navigate = vi.fn(),
  locale?: Locale,
  recoverSession?: (error: unknown) => Promise<void>,
): {
  readonly queryClient: QueryClient;
  readonly store: ReturnType<typeof createStore>;
  readonly navigate: ReturnType<typeof vi.fn>;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = createStore();

  function Wrapper({ children }: PropsWithChildren): ReactElement {
    return (
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </JotaiProvider>
    );
  }

  render(
    <AuthPanel
      api={api}
      navigate={navigate}
      {...(recoverSession === undefined ? {} : { recoverSession })}
    />,
    { wrapper: Wrapper },
  );
  if (locale !== undefined) act(() => store.set(localeAtom, locale));
  return { queryClient, store, navigate };
}

beforeEach(() => {
  history.replaceState(null, "", "/");
  startAuthentication.mockReset();
});

describe("AuthPanel", () => {
  it("detects the adapter from nodeinfo when the scheme is omitted", async () => {
    const user = userEvent.setup();
    const api = apiFixture();
    renderPanel(api);

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "social.example");

    await waitFor(() =>
      expect(api.detectServer).toHaveBeenCalledWith("https://social.example", expect.anything()),
    );
    expect(await screen.findByText("Detected server software: Mastodon")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("keeps Continue disabled and reports failure when detection fails", async () => {
    const user = userEvent.setup();
    renderPanel(
      apiFixture({
        detectServer: vi.fn(async () => {
          throw new WebApiError("UPSTREAM_FAILURE", "The upstream request failed.", 502);
        }),
      }),
    );

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "offline.example");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not identify the server software.",
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("reports unsupported server software by name", async () => {
    const user = userEvent.setup();
    renderPanel(
      apiFixture({
        detectServer: vi.fn(async () => {
          throw new WebApiError(
            "NOT_FOUND",
            'No ActivityPlug adapter matches the server software "wordpress".',
            404,
          );
        }),
      }),
    );

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "blog.example");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      'No ActivityPlug adapter matches the server software "wordpress".',
    );
  });

  it("starts OAuth with the current same-origin return URL after callback cleanup", async () => {
    const user = userEvent.setup();
    const api = apiFixture();
    history.replaceState(null, "", "/local?tab=following&code=secret#latest");
    const { navigate } = renderPanel(api);

    await waitFor(() => expect(location.search).toBe("?tab=following"));

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "https://social.example");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(api.startAuth).toHaveBeenCalledWith({
      kind: "oauth",
      origin: "https://social.example",
      adapter: "mastodon",
      returnTo: `${location.origin}/local?tab=following#latest`,
    });
    expect(navigate).toHaveBeenCalledWith("https://social.example/oauth");
  });

  it("requires a nonblank email before sending a HackersPub challenge", async () => {
    const user = userEvent.setup();
    renderPanel(apiFixture());

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "https://hackers.pub");
    const email = await screen.findByLabelText("Email");
    const sendCode = screen.getByRole("button", { name: "Send code" });

    expect(email).toBeRequired();
    expect(sendCode).toBeDisabled();
    await user.type(email, " ");
    expect(sendCode).toBeDisabled();
    await user.type(email, "alice@example.com");
    expect(sendCode).toBeEnabled();
  });

  it("keeps identity inputs immutable while an email challenge start is pending", async () => {
    const user = userEvent.setup();
    let resolveStart: (result: {
      readonly kind: "emailChallenge";
      readonly challengeId: string;
      readonly expiresAt: string;
    }) => void;
    const deferredStart = new Promise<{
      readonly kind: "emailChallenge";
      readonly challengeId: string;
      readonly expiresAt: string;
    }>((resolve) => {
      resolveStart = resolve;
    });
    const api = apiFixture({
      startAuth: vi.fn(() => deferredStart),
    });
    renderPanel(api);

    await screen.findByRole("button", { name: "Continue" });
    const origin = screen.getByLabelText("Server origin");
    await user.type(origin, "https://hackers.pub");
    await waitFor(() => expect(origin).toHaveValue("https://hackers.pub"));
    const email = await screen.findByLabelText("Email");
    await user.type(email, "alice@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));

    expect(origin).toBeDisabled();
    expect(email).toBeDisabled();
    await user.type(origin, "/ignored");
    expect(origin).toHaveValue("https://hackers.pub");

    await act(async () => {
      resolveStart({
        kind: "emailChallenge",
        challengeId: "opaque-challenge",
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
    });

    expect(await screen.findByLabelText("Verification code")).toBeVisible();
    expect(origin).toBeEnabled();
  });

  it("clears a challenge, its code, and failures when its identity changes", async () => {
    const user = userEvent.setup();
    const api = apiFixture({
      startAuth: vi.fn(async () => ({
        kind: "emailChallenge" as const,
        challengeId: "opaque-challenge",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
      completeAuth: vi.fn(async () => {
        throw new Error("The code expired.");
      }),
    });
    renderPanel(api);

    await screen.findByRole("button", { name: "Continue" });
    const origin = screen.getByLabelText("Server origin");
    await user.type(origin, "https://hackers.pub");
    await waitFor(() => expect(origin).toHaveValue("https://hackers.pub"));
    const email = await screen.findByLabelText("Email");
    await user.type(email, "alice@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const verificationCode = await screen.findByLabelText("Verification code");
    await user.type(verificationCode, "654321");
    // user-event does not yield to real timers between keystrokes, so fire a
    // single change event to keep the debounced detection deterministic.
    fireEvent.change(origin, { target: { value: "changed.hackers.pub" } });

    await waitFor(() => expect(verificationCode).not.toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: "Send code" }, { timeout: 3000 }));
    expect(await screen.findByLabelText("Verification code")).toHaveValue("");
    await user.type(screen.getByLabelText("Verification code"), "654321");
    await user.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The code expired.");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "bob@example.com" } });

    await waitFor(() => expect(verificationCode).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("completes a HackersPub email challenge from direct BFF responses", async () => {
    const user = userEvent.setup();
    const api = apiFixture({
      startAuth: vi.fn(async () => ({
        kind: "emailChallenge" as const,
        challengeId: "opaque-challenge",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
    });
    const { queryClient, store } = renderPanel(api);

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "https://hackers.pub");
    await user.type(await screen.findByLabelText("Email"), "alice@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText("Verification code"), "654321");
    await user.click(screen.getByRole("button", { name: "Verify code" }));

    await waitFor(() =>
      expect(queryClient.getQueryData(webSessionKey)).toEqual(authenticatedSession),
    );
    expect(api.completeAuth).toHaveBeenCalledWith({
      kind: "emailChallenge",
      challengeId: "opaque-challenge",
      code: "654321",
    });
    expect(store.get(authTransitionAtom)).toEqual({ status: "idle" });
    expect(document.body.textContent).not.toContain("opaque-challenge");
  });

  it("passes BFF passkey options unchanged and completes only through AuthApi", async () => {
    const user = userEvent.setup();
    const options = {
      challenge: "Y2hhbGxlbmdl",
      rpId: "hackers.pub",
      userVerification: "preferred" as const,
    };
    const credential = {
      id: "credential-id",
      rawId: "credential-id",
      response: {
        authenticatorData: "authenticator-data",
        clientDataJSON: "client-data",
        signature: "signature",
      },
      type: "public-key" as const,
      clientExtensionResults: {},
      authenticatorAttachment: null,
    };
    const api = apiFixture({
      startAuth: vi.fn(async () => ({
        kind: "passkey" as const,
        challengeId: "passkey-challenge",
        options,
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
    });
    startAuthentication.mockResolvedValue(credential);
    renderPanel(api);

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "https://hackers.pub");
    await user.click(await screen.findByRole("button", { name: "Use passkey" }));

    await waitFor(() => expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options }));
    expect(api.completeAuth).toHaveBeenCalledWith({
      kind: "passkey",
      challengeId: "passkey-challenge",
      credential,
    });
  });

  it("clears credentials and cache before refetching an anonymous logout session", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const session = vi
      .fn()
      .mockImplementationOnce(async () => authenticatedSession)
      .mockImplementationOnce(async () => {
        events.push("session");
        return anonymousSession;
      });
    const api = apiFixture({
      session,
      logout: vi.fn(async () => {
        events.push("logout");
      }),
      setCsrfToken: vi.fn(() => events.push("csrf")),
    });
    const { queryClient, store } = renderPanel(api);
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    store.set(composerAtom, {
      content: "private draft",
      visibility: "followers",
      summary: "",
      sensitive: false,
      attachments: [
        {
          localId: "draft-image",
          file: new File(["image"], "draft.png", { type: "image/png" }),
          previewUrl: "blob:draft-image",
          altText: "draft image",
          status: "draft",
        },
      ],
    });

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("button", { name: "Continue" })).toBeDisabled();
    expect(events).toEqual(["logout", "csrf", "session"]);
    expect(api.setCsrfToken).toHaveBeenCalledWith("");
    expect(queryClient.getQueryData(webSessionKey)).toEqual(anonymousSession);
    expect(store.get(composerAtom)).toMatchObject({ content: "", attachments: [] });
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:draft-image");
  });

  it("discards authenticated cache when logout completion is ambiguous", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const session = vi
      .fn()
      .mockResolvedValueOnce(authenticatedSession)
      .mockImplementationOnce(async () => {
        events.push("session");
        return anonymousSession;
      });
    const api = apiFixture({
      session,
      logout: vi.fn(async () => {
        events.push("logout");
        throw new Error("Logout response was lost.");
      }),
      setCsrfToken: vi.fn(() => events.push("csrf")),
    });
    const { queryClient } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Logout could not be confirmed. Logout response was lost.",
    );
    expect(events).toEqual(["logout", "csrf", "session"]);
    expect(queryClient.getQueryData(webSessionKey)).toEqual(anonymousSession);
  });

  it("keeps a mounted upload coordinator usable after ambiguous logout recovers authenticated", async () => {
    const user = userEvent.setup();
    const uploadMedia = vi.fn(async () => ({
      id: "media-1",
      remoteUrl: "https://cdn.test/media-1.png",
    }));
    const coordinator = new UploadCoordinator({ uploadMedia });
    const unregister = registerUploadCoordinator(coordinator);
    const session = vi.fn(async () => authenticatedSession);
    const api = apiFixture({
      session,
      logout: vi.fn(async () => {
        throw new Error("Logout response was lost.");
      }),
    });

    try {
      renderPanel(api);

      await user.click(await screen.findByRole("button", { name: "Log out" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Logout could not be confirmed. Logout response was lost.",
      );
      expect(session).toHaveBeenCalledTimes(2);
      await expect(
        coordinator.confirm({
          localId: "draft-1",
          file: new File(["image"], "draft.png", { type: "image/png" }),
          previewUrl: "blob:draft-1",
          altText: "Draft image",
          status: "draft",
        }),
      ).resolves.toMatchObject({ status: "uploaded", mediaId: "media-1" });
    } finally {
      unregister();
      await coordinator.dispose();
    }
  });

  it("settles unheld media cleanup before logout and preserves held unknown media", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const cleanup = Promise.withResolvers<void>();
    const deleteMedia = vi.fn((mediaId: string) => {
      events.push(`cleanup-start:${mediaId}`);
      return cleanup.promise.finally(() => events.push(`cleanup-settled:${mediaId}`));
    });
    const coordinator = new UploadCoordinator(
      { uploadMedia: vi.fn(), deleteMedia },
      { canDeleteMedia: true },
    );
    const unheld = uploadedAttachment("unheld-draft", "unheld-media");
    const held = uploadedAttachment("held-draft", "held-media");
    coordinator.track(unheld);
    coordinator.hold([held]);
    registerUploadCoordinator(coordinator);
    const session = vi
      .fn()
      .mockResolvedValueOnce(authenticatedSession)
      .mockImplementationOnce(async () => {
        events.push("session");
        return anonymousSession;
      });
    const api = apiFixture({
      session,
      abortUnsafeRequests: vi.fn(() => events.push("abort")),
      logout: vi.fn(async () => {
        events.push("logout");
      }),
      setCsrfToken: vi.fn(() => events.push("csrf")),
    });
    renderPanel(api);

    await user.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(deleteMedia).toHaveBeenCalledWith("unheld-media"));
    expect(api.logout).not.toHaveBeenCalled();
    cleanup.reject(new Error("Remote cleanup failed."));

    expect(await screen.findByRole("button", { name: "Continue" })).toBeDisabled();
    expect(deleteMedia).not.toHaveBeenCalledWith("held-media");
    expect(coordinator.get("held-draft")).toEqual(held);
    expect(events).toEqual([
      "abort",
      "cleanup-start:unheld-media",
      "cleanup-settled:unheld-media",
      "logout",
      "abort",
      "csrf",
      "session",
    ]);
  });

  it.each([
    ["en", "Language", "Korean"],
    ["ko", "언어", "일본어"],
    ["ja", "言語", "韓国語"],
  ] as const)(
    "offers the shared locale selection before sign-in in %s",
    async (locale, label, option) => {
      renderPanel(apiFixture(), vi.fn(), locale);

      expect(await screen.findByLabelText(label)).toBeVisible();
      expect(screen.getByRole("option", { name: option })).toBeVisible();
    },
  );

  it("renders failures accessibly and preserves retry fields", async () => {
    const user = userEvent.setup();
    const api = apiFixture({
      startAuth: vi.fn(async () => {
        throw new Error("Authentication service unavailable");
      }),
    });
    renderPanel(api);

    await screen.findByRole("button", { name: "Continue" });
    await user.type(screen.getByLabelText("Server origin"), "https://social.example");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Authentication service unavailable",
    );
    expect(screen.getByLabelText("Server origin")).toHaveValue("https://social.example");
  });
});

function uploadedAttachment(localId: string, mediaId: string) {
  return {
    localId,
    file: new File([localId], `${localId}.png`, { type: "image/png" }),
    previewUrl: `blob:${localId}`,
    altText: "Alt",
    status: "uploaded" as const,
    mediaId,
    remoteUrl: `https://cdn.test/${mediaId}.png`,
  };
}
