import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useMemo, useRef } from "react";

import { createProductApi, type ProductApi, webKeys } from "./api/client.js";
import { type BrowserCapabilitySet } from "./api/contracts.js";
import { createBrowserApi } from "./api/http.js";
import { AuthPanel } from "./features/auth/auth-panel.js";
import { Composer, type ComposerControlDecisions } from "./features/composer/composer.js";
import { type MediaUploadPort } from "./features/composer/uploads.js";
import { ProductShell } from "./features/layout/product-shell.js";
import { BrowserPostSurface } from "./features/posts/browser-post-surface.js";
import { controlDecision } from "./features/posts/capability.js";
import { ThreadView } from "./features/posts/thread-view.js";
import { ProfileView } from "./features/profile/profile.js";
import { SearchView } from "./features/search/search.js";
import { Timeline } from "./features/timeline/timeline.js";
import { useI18n } from "./i18n/i18n.js";
import { LocaleControl } from "./i18n/locale-control.js";
import { useProductLocation } from "./routing/location.js";
import { useUnauthenticatedRecovery } from "./state/auth-recovery.js";
import { sessionOptions } from "./state/auth.js";

const browserApi = createBrowserApi();
const productApi = createProductApi(browserApi);

export interface AppProps {
  /** Tests can provide a controlled BFF facade; production uses one module singleton. */
  readonly api?: ProductApi;
}

export function App({ api = productApi }: AppProps): ReactElement {
  const session = useQuery(sessionOptions(api));
  const recoverSession = useUnauthenticatedRecovery(api);
  const { t } = useI18n();

  if (session.isPending) {
    return (
      <main aria-labelledby="app-title" className="shell">
        <h1 id="app-title">ActivityPlug</h1>
        <p aria-live="polite" role="status">
          {t("auth.loading")}
        </p>
      </main>
    );
  }
  if (session.isError) {
    return (
      <main aria-labelledby="app-title" className="shell">
        <h1 id="app-title">ActivityPlug</h1>
        <p role="alert">{session.error.message || t("auth.callbackFailed")}</p>
      </main>
    );
  }
  if (!session.data.authenticated) {
    return <PublicAuthShell api={api} recoverSession={recoverSession} />;
  }
  return (
    <AuthenticatedProduct
      api={api}
      capabilities={session.data.capabilities}
      recoverSession={recoverSession}
    />
  );
}

function PublicAuthShell({
  api,
  recoverSession,
}: {
  readonly api: ProductApi;
  readonly recoverSession: (error: unknown) => Promise<void>;
}): ReactElement {
  const { t } = useI18n();

  return (
    <main aria-labelledby="app-title" className="public-auth-shell">
      <section className="public-auth-shell__card">
        <header className="public-auth-shell__header">
          <div>
            <h1 id="app-title">ActivityPlug</h1>
            <p>{t("auth.welcome")}</p>
          </div>
          <LocaleControl />
        </header>
        <AuthPanel api={api} recoverSession={recoverSession} showLocaleControl={false} />
      </section>
    </main>
  );
}

function AuthenticatedProduct({
  api,
  capabilities,
  recoverSession,
}: {
  readonly api: ProductApi;
  readonly capabilities: BrowserCapabilitySet;
  readonly recoverSession: (error: unknown) => Promise<void>;
}): ReactElement {
  const composerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const location = useProductLocation();
  const { t } = useI18n();
  const focusComposer = (): void => {
    window.setTimeout(() =>
      composerRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(),
    );
  };
  const advertisedCreate = controlDecision(capabilities, "create", t);
  const createInputs = acceptedCreateInputs(capabilities);
  const supportedVisibilities = supportedCreateVisibilities(createInputs);
  const create =
    advertisedCreate.enabled && supportedVisibilities.length === 0
      ? { enabled: false, reason: t("capability.unsupported") }
      : advertisedCreate;
  const inputControl = (input: string) =>
    create.enabled && (createInputs === undefined || createInputs.has(input))
      ? { enabled: true }
      : { enabled: false, reason: create.reason ?? t("capability.unsupported") };
  const composerControls: ComposerControlDecisions = {
    content: inputControl("content"),
    create,
    contentWarning: inputControl("summary"),
    sensitive: inputControl("sensitive"),
    visibility: create,
    reply: controlDecision(capabilities, "reply", t),
    quote: controlDecision(capabilities, "quote", t),
    upload: controlDecision(capabilities, "upload", t),
    deleteUpload: controlDecision(capabilities, "deleteUpload", t),
  };
  const media = useMemo<MediaUploadPort>(
    () => ({
      uploadMedia: async (input, signal) => {
        const response = await api.uploadMedia(input, signal);
        return {
          id: response.media.ref.id,
          ...(response.media.url === undefined ? {} : { remoteUrl: response.media.url }),
        };
      },
      deleteMedia: async (id) => {
        await api.deleteMedia(id);
      },
    }),
    [api],
  );

  const composer = (
    <div ref={composerRef}>
      <Composer
        controls={composerControls}
        media={media}
        onPostCreated={async () => {
          await queryClient.invalidateQueries({ queryKey: webKeys.posts });
        }}
        posts={{ createPost: (input) => api.createPost(input) }}
        supportedVisibilities={
          supportedVisibilities.length === 0 ? ["public"] : supportedVisibilities
        }
      />
    </div>
  );

  return (
    <ProductShell
      context={composer}
      headerActions={<AuthPanel api={api} recoverSession={recoverSession} />}
    >
      {location.name === "home" || location.name === "local" || location.name === "federated" ? (
        <Timeline
          api={api}
          kind={location.name === "home" ? "home" : location.name}
          labels={{
            navigation: t("timeline.navigation"),
            home: t("nav.home"),
            local: t("nav.local"),
            federated: t("nav.federated"),
            loading: t("timeline.loading"),
            loadingMore: t("timeline.loadingMore"),
            loadMore: t("timeline.loadMore"),
            retry: t("timeline.retry"),
            empty: t("timeline.empty"),
            failed: t("timeline.failed"),
            replyTo: t("post.reply"),
            quoteOf: t("post.quote"),
            boostOf: t("post.boost"),
          }}
          renderPost={(post) => (
            <BrowserPostSurface
              api={api}
              capabilities={capabilities}
              onTarget={focusComposer}
              post={post}
            />
          )}
        />
      ) : null}
      {location.name === "search" ? (
        <SearchView
          api={api}
          capabilities={capabilities}
          initialQuery={location.query}
          labels={{
            label: t("search.label"),
            all: t("search.all"),
            accounts: t("search.accounts"),
            posts: t("search.posts"),
            hashtags: t("search.hashtags"),
            prompt: t("search.prompt"),
            empty: t("search.empty"),
            loading: t("search.loading"),
            failed: t("search.failed"),
            loadMore: t("search.loadMore"),
            loadingMore: t("search.loadingMore"),
            result: t("search.result"),
            results: t("search.results"),
            unsupported: t("capability.unsupported"),
            unknown: t("capability.unknown"),
          }}
          renderPost={(post) => (
            <BrowserPostSurface
              api={api}
              capabilities={capabilities}
              onTarget={focusComposer}
              post={post}
            />
          )}
        />
      ) : null}
      {location.name === "profile" ? (
        location.id === null ? (
          <RouteState message={t("route.missingProfile")} />
        ) : (
          <ProfileView
            api={api}
            followCapability={followCapability(capabilities)}
            id={location.id}
            labels={{
              bot: t("profile.bot"),
              avatar: (name) => t("profile.avatar", { name }),
              locked: t("profile.locked"),
              follow: t("profile.follow"),
              unfollow: t("profile.unfollow"),
              followers: t("profile.followers"),
              following: t("profile.following"),
              postsCount: t("profile.postsCount"),
              fields: t("profile.fields"),
              loading: t("profile.loading"),
              failed: t("profile.failed"),
              loadMore: t("profile.loadMore"),
              loadingMore: t("profile.loadingMore"),
              emptyPosts: t("profile.empty"),
              relationshipUnavailable: t("profile.relationshipUnavailable"),
            }}
            renderPost={(post) => (
              <BrowserPostSurface
                api={api}
                capabilities={capabilities}
                onTarget={focusComposer}
                post={post}
              />
            )}
          />
        )
      ) : null}
      {location.name === "post" ? (
        location.id === null ? (
          <RouteState message={t("route.missingPost")} />
        ) : (
          <PostRoute
            api={api}
            capabilities={capabilities}
            id={location.id}
            onTarget={focusComposer}
          />
        )
      ) : null}
      {location.name === "notFound" ? <RouteState message={t("route.notFound")} /> : null}
    </ProductShell>
  );
}

function PostRoute({
  api,
  capabilities,
  id,
  onTarget,
}: {
  readonly api: ProductApi;
  readonly capabilities: BrowserCapabilitySet;
  readonly id: string;
  readonly onTarget: () => void;
}): ReactElement {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: webKeys.post(id),
    queryFn: ({ signal }) => api.post(id, signal),
    retry: false,
  });
  if (query.isPending) return <p role="status">{t("route.loadingPost")}</p>;
  if (query.isError) return <p role="alert">{query.error.message || t("route.postFailed")}</p>;
  return (
    <ThreadView
      capabilities={capabilities}
      current={query.data.post}
      loadContext={async (postId, signal) => api.postContext(postId, signal)}
      renderPost={(post) => (
        <BrowserPostSurface api={api} capabilities={capabilities} onTarget={onTarget} post={post} />
      )}
    />
  );
}

function RouteState({ message }: { readonly message: string }): ReactElement {
  return <p role="alert">{message}</p>;
}

function followCapability(capabilities: BrowserCapabilitySet) {
  const capability = capabilities.capabilities.find(
    (candidate: { readonly name: string }) => candidate.name === "social.follow",
  );
  return {
    name: "social.follow" as const,
    status: capability?.status ?? "unknown",
    reason: capability?.reason ?? null,
  };
}

const composerVisibilities = ["public", "unlisted", "followers", "direct", "local"] as const;

function acceptedCreateInputs(capabilities: BrowserCapabilitySet): ReadonlySet<string> | undefined {
  const create = capabilities.capabilities.find((capability) => capability.name === "posts.create");
  const acceptedInputs =
    create?.constraints
      .filter(
        (constraint): constraint is { readonly name: "acceptedInput"; readonly value: string } =>
          constraint.name === "acceptedInput" && typeof constraint.value === "string",
      )
      .map((constraint) => constraint.value) ?? [];
  return acceptedInputs.length === 0 ? undefined : new Set(acceptedInputs);
}

function supportedCreateVisibilities(
  acceptedInputs: ReadonlySet<string> | undefined,
): readonly (typeof composerVisibilities)[number][] {
  if (acceptedInputs === undefined) return composerVisibilities;
  const supported = composerVisibilities.filter((visibility) =>
    acceptedInputs.has(`visibility.${visibility}`),
  );
  return supported;
}
