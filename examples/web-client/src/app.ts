import { type PostVisibilityInput } from "@activityplug/core";

import {
  clearPendingHackersPubLogin,
  clearStoredAuthState,
  createHackersPubVerifyUrl,
  resolveHackersPubCallback,
  storePendingHackersPubLogin,
  storeStartedAuthState,
  storedStartedAuthState,
  type PendingHackersPubLogin,
} from "./callback-state.js";
import {
  canUseHackersPubPasskey,
  completeHackersPubEmailLogin,
  exchangeAuth,
  importToken,
  loginHackersPubByPasskey,
  startAuth,
  startHackersPubEmailLogin,
  type ExchangedAuth,
  type StartedAuth,
  type WebClientAdapter,
} from "./index.js";
import { PanelRevisionTracker, type PanelRequest } from "./panel-revisions.js";
import { createClientUuid } from "./uuid.js";

import appStyles from "./app.css?inline";

interface StoredStartedAuth extends Omit<StartedAuth, "authorizationUrl" | "fetch"> {
  readonly authorizationUrl: string;
  readonly startedAtOrigin: string;
}

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("Missing app root.");
const style = document.createElement("style");
style.textContent = appStyles;
document.head.append(style);

app.innerHTML = `
  <section class="shell">
    <header>
      <h1>ActivityPlug Web Client</h1>
      <p>OAuth login, viewer lookup, timelines, search, posts, and social actions through the public library API.</p>
    </header>
    <form id="auth-form">
      <label>
        Adapter
        <select name="adapter">
          <option value="mastodon">Mastodon</option>
          <option value="misskey">Misskey</option>
          <option value="hackerspub">HackersPub</option>
        </select>
      </label>
      <label>
        Origin
        <input name="origin" placeholder="https://mastodon.example" required />
      </label>
      <label>
        Client name
        <input name="clientName" value="ActivityPlug Example Web Client" required />
      </label>
      <label>
        Scopes
        <input name="scopes" value="read write follow" required />
      </label>
      <label>
        Existing token or session ID
        <input name="sessionToken" placeholder="Remote token, or HackersPub Session.id" />
      </label>
      <label data-hackerspub-login>
        HackersPub email or username
        <input name="hackersPubIdentifier" autocomplete="username email webauthn" />
      </label>
      <label data-hackerspub-login>
        HackersPub challenge token
        <input name="hackersPubChallengeToken" />
      </label>
      <label data-hackerspub-login>
        HackersPub verification code
        <input name="hackersPubCode" autocomplete="one-time-code" />
      </label>
      <label>
        Search query
        <input name="query" value="activityplug" />
      </label>
      <div class="actions">
        <button type="submit">Continue</button>
        <button type="button" id="passkey-login" data-hackerspub-login>HackersPub passkey</button>
        <button type="button" id="clear-session">Clear session</button>
      </div>
    </form>
    <section id="output" aria-live="polite"></section>
    <section id="workspace" hidden>
      <section id="own-posts-output" class="result-panel" aria-live="polite"></section>
      <form id="compose-form">
        <label>
          Post content
          <textarea name="content" rows="4" placeholder="Write a post"></textarea>
        </label>
        <label>
          Visibility
          <select name="visibility"></select>
        </label>
        <label>
          Reply to post ID
          <input name="replyToId" placeholder="ActivityPlug post ID" />
        </label>
        <label>
          Quote post ID
          <input name="quoteOfId" placeholder="ActivityPlug post ID" />
        </label>
        <div class="actions">
          <button type="submit" name="intent" value="compose">Post</button>
          <button type="submit" name="intent" value="reply">Reply</button>
          <button type="submit" name="intent" value="quote">Quote</button>
        </div>
      </form>
      <form id="own-posts-form">
        <button type="submit">Load my posts</button>
      </form>
      <section id="search-output" class="result-panel" aria-live="polite"></section>
      <form id="search-form">
        <label>
          Search
          <input name="searchQuery" value="activityplug" />
        </label>
        <label>
          Search type
          <select name="searchType">
            <option value="posts">Posts</option>
            <option value="accounts">Accounts</option>
            <option value="hashtags">Hashtags</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <section id="action-output" class="result-panel" aria-live="polite"></section>
      <form id="action-form">
        <label>
          Post ID
          <input name="postId" placeholder="ActivityPlug post ID" />
        </label>
        <label>
          Account ID
          <input name="accountId" placeholder="ActivityPlug account ID" />
        </label>
        <label>
          Emoji
          <input name="emoji" value="👍" />
        </label>
        <div class="actions">
          <button type="button" data-action="favourite">Favourite</button>
          <button type="button" data-action="bookmark">Bookmark</button>
          <button type="button" data-action="boost">Boost</button>
          <button type="button" data-action="react">React</button>
          <button type="button" data-action="follow">Follow</button>
          <button type="button" data-action="unfollow">Unfollow</button>
          <button type="button" data-action="mute">Mute</button>
          <button type="button" data-action="block">Block</button>
        </div>
      </form>
    </section>
  </section>
`;

const output = element("#output", HTMLElement);
const ownPostsOutput = element("#own-posts-output", HTMLElement);
const searchOutput = element("#search-output", HTMLElement);
const actionOutput = element("#action-output", HTMLElement);
const workspace = element("#workspace", HTMLElement);
const form = element("#auth-form", HTMLFormElement);
const passkeyButton = element("#passkey-login", HTMLButtonElement);
const visibilitySelect = element("[name='visibility']", HTMLSelectElement);
let activeClient: ExchangedAuth | undefined;
let activeViewerAccountId: string | undefined;
let activeAdapter: WebClientAdapter | undefined;
let sessionGeneration = 0;
const panelRevisions = new PanelRevisionTracker<ExchangedAuth>();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void beginAuth(new FormData(form));
});

form.addEventListener("input", (event) => {
  handleAuthFormChange(event.target);
});
form.addEventListener("change", (event) => {
  handleAuthFormChange(event.target);
});

element("#clear-session", HTMLButtonElement).addEventListener("click", () => {
  clearStoredAuthState(sessionStorage);
  clearPendingHackersPubLogin(sessionStorage);
  beginSessionReset();
  render("Stored OAuth state was cleared.");
});

passkeyButton.addEventListener("click", () => {
  void beginHackersPubPasskeyLogin(new FormData(form));
});

element("#compose-form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void runComposeAction(
    new FormData(formElement(event.currentTarget, "compose form")),
    event.submitter,
  );
});

element("#search-form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearchAction(new FormData(formElement(event.currentTarget, "search form")));
});

element("#own-posts-form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void loadOwnPosts();
});

element("#action-form", HTMLFormElement).addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const action = target.dataset["action"];
  if (action === undefined) return;
  void runSocialAction(action, new FormData(formElement(event.currentTarget, "action form")));
});

updateAdapterUi();
void resumeCallback();

async function beginAuth(formData: FormData): Promise<void> {
  const generation = beginSessionReset();
  try {
    const adapter = formValue(formData, "adapter") as WebClientAdapter;
    const sessionToken = optionalFormValue(formData, "sessionToken");
    if (sessionToken !== undefined) {
      const client = await importToken({
        adapter,
        origin: formValue(formData, "origin"),
        accessToken: sessionToken,
        scopes: formValue(formData, "scopes").split(/\s+/u).filter(Boolean),
      });
      await renderAuthenticatedClient(client, generation);
      return;
    }
    if (adapter === "hackerspub") {
      await beginHackersPubEmailLogin(formData, generation);
      return;
    }
    const redirectUri = callbackUrl();
    const startedAuth = await startAuth({
      adapter,
      origin: formValue(formData, "origin"),
      clientName: formValue(formData, "clientName"),
      redirectUri,
      scopes: formValue(formData, "scopes").split(/\s+/u).filter(Boolean),
      state: createClientUuid(),
      website: location.origin,
    });
    if (!isCurrentGeneration(generation)) return;
    storeStartedAuth(startedAuth);
    location.assign(startedAuth.authorizationUrl.href);
  } catch (error) {
    if (isCurrentGeneration(generation)) renderError(error);
  }
}

async function resumeCallback(): Promise<void> {
  const callback = new URL(location.href);
  const hackersPubCallback = resolveHackersPubCallback(sessionStorage, callback);
  if (hackersPubCallback.kind !== "none") {
    const generation = sessionGeneration;
    let pendingLogin: PendingHackersPubLogin | null = null;
    try {
      if (hackersPubCallback.kind === "invalid") {
        pendingLogin = hackersPubCallback.pendingLogin ?? null;
        throw new Error(hackersPubCallback.message);
      }
      pendingLogin = hackersPubCallback.pendingLogin;
      const client = await completeHackersPubEmailLogin({
        origin: pendingLogin.origin,
        token: pendingLogin.token,
        code: hackersPubCallback.code,
      });
      clearPendingHackersPubLogin(sessionStorage, pendingLogin.state);
      history.replaceState(null, "", callbackUrl());
      await renderAuthenticatedClient(client, generation);
    } catch (error) {
      if (pendingLogin !== null) clearPendingHackersPubLogin(sessionStorage, pendingLogin.state);
      if (isCurrentGeneration(generation)) renderError(error);
    }
    return;
  }
  if (!callback.searchParams.has("code") && !callback.searchParams.has("error")) {
    render("Ready.");
    return;
  }
  render("OAuth callback detected. Exchanging authorization code...");
  const callbackState = callback.searchParams.get("state");
  const stored = storedStartedAuthState(sessionStorage, callbackState);
  if (stored === null) {
    render(
      [
        "No stored OAuth state was found for this callback.",
        `Current browser origin: ${location.origin}`,
        "Start OAuth and receive the callback on the same browser origin.",
        `For example, do not mix ${localhostExampleUrl()} and ${loopbackExampleUrl()} in one login attempt.`,
      ].join("\n"),
    );
    return;
  }
  const generation = sessionGeneration;
  try {
    const startedAuth = deserializeStartedAuth(JSON.parse(stored) as StoredStartedAuth);
    if (startedAuth.state !== callbackState) {
      throw new Error("The OAuth callback state does not match the stored login attempt.");
    }
    const client = await exchangeAuth({
      startedAuth,
      callback,
      redirectUri: startedAuth.redirectUri,
    });
    clearStoredAuthState(sessionStorage, startedAuth.state);
    history.replaceState(null, "", callbackUrl());
    await renderAuthenticatedClient(client, generation);
  } catch (error) {
    if (isCurrentGeneration(generation)) renderError(error);
  }
}

async function beginHackersPubEmailLogin(formData: FormData, generation: number): Promise<void> {
  const origin = formValue(formData, "origin");
  const token = optionalFormValue(formData, "hackersPubChallengeToken");
  const code = optionalFormValue(formData, "hackersPubCode");
  if (token !== undefined && code !== undefined) {
    await renderAuthenticatedClient(
      await completeHackersPubEmailLogin({ origin, token, code }),
      generation,
    );
    return;
  }
  const identifier = optionalFormValue(formData, "hackersPubIdentifier");
  if (identifier === undefined) {
    throw new Error(
      "HackersPub does not support OAuth. Enter an email or username, a challenge token and code, use passkey login, or paste an existing Session.id.",
    );
  }
  const state = createClientUuid();
  const challenge = await startHackersPubEmailLogin({
    origin,
    identifier,
    verifyUrl: createHackersPubVerifyUrl({
      callbackUrl: callbackUrl(),
      origin,
      state,
    }),
  });
  if (!isCurrentGeneration(generation)) return;
  storePendingHackersPubLogin(sessionStorage, { origin, token: challenge.token, state });
  formInput("hackersPubChallengeToken").value = challenge.token;
  render(
    [
      "HackersPub sent a login email.",
      "Open the email link, or enter the verification code from the email and submit again.",
      `Challenge token: ${challenge.token}`,
    ].join("\n"),
  );
}

async function beginHackersPubPasskeyLogin(formData: FormData): Promise<void> {
  const generation = beginSessionReset();
  try {
    const adapter = formValue(formData, "adapter") as WebClientAdapter;
    if (adapter !== "hackerspub") {
      throw new Error("Passkey login is only available for HackersPub.");
    }
    const client = await loginHackersPubByPasskey({
      origin: formValue(formData, "origin"),
    });
    await renderAuthenticatedClient(client, generation);
  } catch (error) {
    if (isCurrentGeneration(generation)) renderError(error);
  }
}

function serializeStartedAuth(startedAuth: StartedAuth): StoredStartedAuth {
  return {
    adapter: startedAuth.adapter,
    origin: startedAuth.origin,
    client: startedAuth.client,
    authorizationUrl: startedAuth.authorizationUrl.href,
    redirectUri: startedAuth.redirectUri,
    state: startedAuth.state,
    startedAtOrigin: location.origin,
    ...(startedAuth.codeVerifier === undefined ? {} : { codeVerifier: startedAuth.codeVerifier }),
    ...(startedAuth.codeChallenge === undefined
      ? {}
      : { codeChallenge: startedAuth.codeChallenge }),
    ...(startedAuth.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: startedAuth.codeChallengeMethod }),
  };
}

function deserializeStartedAuth(stored: StoredStartedAuth): StartedAuth {
  if (stored.startedAtOrigin !== location.origin) {
    throw new Error(
      [
        "The OAuth login was started on a different browser origin.",
        `Started on: ${stored.startedAtOrigin}`,
        `Returned to: ${location.origin}`,
        "Open the example with one exact URL and retry the login.",
      ].join("\n"),
    );
  }
  return {
    ...stored,
    authorizationUrl: new URL(stored.authorizationUrl),
  };
}

function storeStartedAuth(startedAuth: StartedAuth): void {
  const serialized = JSON.stringify(serializeStartedAuth(startedAuth));
  storeStartedAuthState(sessionStorage, startedAuth.state, serialized);
}

function callbackUrl(): string {
  return `${location.origin}${location.pathname}`;
}

function localhostExampleUrl(): string {
  return `http://localhost${location.port === "" ? "" : `:${location.port}`}`;
}

function loopbackExampleUrl(): string {
  return `http://127.0.0.1${location.port === "" ? "" : `:${location.port}`}`;
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing form value: ${name}`);
  }
  return value.trim();
}

function optionalFormValue(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formInput(name: string): HTMLInputElement {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${name}`);
  return input;
}

function formSelect(name: string): HTMLSelectElement {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLSelectElement)) throw new Error(`Missing select: ${name}`);
  return input;
}

function formElement(target: EventTarget | null, name: string): HTMLFormElement {
  if (!(target instanceof HTMLFormElement)) throw new Error(`Missing ${name}.`);
  return target;
}

function element<T extends Element>(
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const found = document.querySelector(selector);
  if (!(found instanceof constructor)) throw new Error(`Missing element: ${selector}`);
  return found;
}

function render(message: string): void {
  output.textContent = message;
}

async function renderAuthenticatedClient(client: ExchangedAuth, generation: number): Promise<void> {
  const viewer = await client.verifyViewer();
  if (!isCurrentGeneration(generation)) return;
  setActiveClient(client, viewer.ref.id, client.session.adapter as WebClientAdapter);
  const ownPostsHydrationRevision = panelRevisions.current("ownPosts");
  const searchHydrationRevision = panelRevisions.current("search");
  const actionHydrationRevision = panelRevisions.current("action");
  const [ownPosts, instance, publicTimeline, localTimeline, search] = await Promise.allSettled([
    client.listAccountPosts(viewer.ref.id),
    client.detectInstance(),
    client.renderPublicTimeline(),
    client.renderLocalTimeline(),
    client.search(formInput("query").value || "activityplug", "posts"),
  ]);
  if (!isCurrentGeneration(generation)) return;
  render(
    [
      `Logged in: ${viewer.acct}`,
      lineFor("Instance", instance, (profile) =>
        `${profile.software.name} ${profile.software.version ?? ""}`.trim(),
      ),
      lineFor("My posts", ownPosts, (connection) => connection.nodes.length.toString()),
      lineFor("Public timeline posts", publicTimeline, (connection) =>
        connection.nodes.length.toString(),
      ),
      lineFor("Local timeline posts", localTimeline, (connection) =>
        connection.nodes.length.toString(),
      ),
      lineFor("Search posts", search, (result) => result.posts.length.toString()),
      "",
      "Use the action forms below to compose, search, and run social actions.",
    ].join("\n"),
  );
  if (panelRevisions.canHydrate("ownPosts", ownPostsHydrationRevision)) {
    renderOwnPosts(
      ownPosts.status === "fulfilled"
        ? formatPostConnection("My posts", ownPosts.value)
        : `My posts: unavailable (${errorMessage(ownPosts.reason)})`,
    );
  }
  if (panelRevisions.canHydrate("search", searchHydrationRevision)) renderSearchResult("");
  if (panelRevisions.canHydrate("action", actionHydrationRevision)) renderActionResult("");
}

async function runComposeAction(formData: FormData, submitter: HTMLElement | null): Promise<void> {
  let request: PanelRequest<ExchangedAuth> | undefined;
  try {
    const client = requireActiveClient();
    const generation = sessionGeneration;
    request = beginPanelRequest("action", client, generation);
    const intent =
      submitter instanceof HTMLButtonElement ? submitter.value : formValue(formData, "intent");
    const content = formValue(formData, "content");
    const visibility = formValue(formData, "visibility") as PostVisibilityInput;
    const post =
      intent === "reply"
        ? await client.reply(formValue(formData, "replyToId"), content, visibility)
        : intent === "quote"
          ? await client.quote(formValue(formData, "quoteOfId"), content, visibility)
          : await client.compose(content, visibility);
    if (!isCurrentPanelRequest(request)) return;
    renderActionResult(
      [
        `Post created: ${post.ref.id}`,
        `Raw post ID: ${post.ref.rawId}`,
        `URL: ${post.url ?? "unavailable"}`,
      ].join("\n"),
    );
  } catch (error) {
    if (shouldRenderPanelRequestError(request)) renderActionResult(errorMessage(error));
  }
}

async function loadOwnPosts(): Promise<void> {
  let request: PanelRequest<ExchangedAuth> | undefined;
  try {
    const client = requireActiveClient();
    const generation = sessionGeneration;
    request = beginPanelRequest("ownPosts", client, generation);
    if (activeViewerAccountId === undefined) {
      throw new Error("Viewer account is not available.");
    }
    const posts = await client.listAccountPosts(activeViewerAccountId);
    if (!isCurrentPanelRequest(request)) return;
    renderOwnPosts(formatPostConnection("My posts", posts));
  } catch (error) {
    if (shouldRenderPanelRequestError(request)) renderOwnPosts(errorMessage(error));
  }
}

async function runSearchAction(formData: FormData): Promise<void> {
  let request: PanelRequest<ExchangedAuth> | undefined;
  try {
    const client = requireActiveClient();
    const generation = sessionGeneration;
    request = beginPanelRequest("search", client, generation);
    const result = await client.search(
      formValue(formData, "searchQuery"),
      formValue(formData, "searchType") as "accounts" | "hashtags" | "posts",
    );
    if (!isCurrentPanelRequest(request)) return;
    renderSearchResult(formatSearchResult(result));
  } catch (error) {
    if (shouldRenderPanelRequestError(request)) renderSearchResult(errorMessage(error));
  }
}

async function runSocialAction(action: string, formData: FormData): Promise<void> {
  let request: PanelRequest<ExchangedAuth> | undefined;
  try {
    const client = requireActiveClient();
    const generation = sessionGeneration;
    request = beginPanelRequest("action", client, generation);
    if (action === "favourite") {
      const post = await client.favourite(formValue(formData, "postId"));
      if (!isCurrentPanelRequest(request)) return;
      renderPostAction("Favourited", post);
      return;
    }
    if (action === "bookmark") {
      const post = await client.bookmark(formValue(formData, "postId"));
      if (!isCurrentPanelRequest(request)) return;
      renderPostAction("Bookmarked", post);
      return;
    }
    if (action === "boost") {
      const post = await client.boost(formValue(formData, "postId"));
      if (!isCurrentPanelRequest(request)) return;
      renderPostAction("Boosted", post);
      return;
    }
    if (action === "react") {
      const post = await client.react(formValue(formData, "postId"), formValue(formData, "emoji"));
      if (!isCurrentPanelRequest(request)) return;
      renderPostAction("Reacted", post);
      return;
    }
    const accountId = formValue(formData, "accountId");
    const relationship =
      action === "follow"
        ? await client.follow(accountId)
        : action === "unfollow"
          ? await client.unfollow(accountId)
          : action === "mute"
            ? await client.mute(accountId)
            : action === "block"
              ? await client.block(accountId)
              : undefined;
    if (relationship === undefined) throw new Error(`Unknown action: ${action}`);
    if (!isCurrentPanelRequest(request)) return;
    renderActionResult(
      [
        `Relationship updated: ${accountId}`,
        `Following: ${relationship.following}`,
        `Muting: ${relationship.muting}`,
        `Blocking: ${relationship.blocking}`,
      ].join("\n"),
    );
  } catch (error) {
    if (shouldRenderPanelRequestError(request)) renderActionResult(errorMessage(error));
  }
}

function requireActiveClient(): ExchangedAuth {
  if (activeClient === undefined) {
    throw new Error("Log in before running this action.");
  }
  return activeClient;
}

function setActiveClient(
  client: ExchangedAuth | undefined,
  viewerAccountId?: string,
  adapter?: WebClientAdapter,
): void {
  activeClient = client;
  activeViewerAccountId = viewerAccountId;
  activeAdapter = adapter;
  workspace.hidden = client === undefined;
  if (client === undefined) {
    renderOwnPosts("");
    renderSearchResult("");
    renderActionResult("");
  }
  updateVisibilityOptions(adapter ?? (formSelect("adapter").value as WebClientAdapter));
}

function beginSessionReset(): number {
  sessionGeneration += 1;
  setActiveClient(undefined);
  return sessionGeneration;
}

function isCurrentGeneration(generation: number): boolean {
  return generation === sessionGeneration;
}

function beginPanelRequest(
  panel: PanelRequest<ExchangedAuth>["panel"],
  client: ExchangedAuth,
  generation: number,
): PanelRequest<ExchangedAuth> {
  return panelRevisions.beginRequest(panel, client, generation);
}

function isCurrentPanelRequest(request: PanelRequest<ExchangedAuth>): boolean {
  return panelRevisions.isCurrentRequest(request, activeClient, sessionGeneration);
}

function shouldRenderPanelRequestError(request: PanelRequest<ExchangedAuth> | undefined): boolean {
  return request === undefined || isCurrentPanelRequest(request);
}

function renderOwnPosts(message: string): void {
  panelRevisions.markRendered("ownPosts");
  renderResult(ownPostsOutput, message);
}

function renderSearchResult(message: string): void {
  panelRevisions.markRendered("search");
  renderResult(searchOutput, message);
}

function renderActionResult(message: string): void {
  panelRevisions.markRendered("action");
  renderResult(actionOutput, message);
}

function renderPostAction(label: string, post: Awaited<ReturnType<ExchangedAuth["favourite"]>>) {
  renderActionResult([`${label}: ${post.ref.id}`, `Raw post ID: ${post.ref.rawId}`].join("\n"));
}

function formatSearchResult(result: Awaited<ReturnType<ExchangedAuth["search"]>>): string {
  return [
    `Accounts: ${result.accounts.length}`,
    ...result.accounts.slice(0, 5).map((account) => `- ${account.acct}: ${account.ref.id}`),
    `Posts: ${result.posts.length}`,
    ...result.posts.slice(0, 5).map((post) => `- ${post.ref.rawId}: ${post.ref.id}`),
    `Hashtags: ${result.hashtags.length}`,
    ...result.hashtags.slice(0, 5).map((hashtag) => `- #${hashtag.name}`),
  ].join("\n");
}

function formatPostConnection(
  label: string,
  connection: Awaited<ReturnType<ExchangedAuth["listAccountPosts"]>>,
): string {
  return [
    `${label}: ${connection.nodes.length}`,
    ...connection.nodes
      .slice(0, 10)
      .map((post) => `- ${post.ref.rawId} [${post.visibility}]: ${post.ref.id}`),
  ].join("\n");
}

function updatePasskeyButton(): void {
  const adapter = formSelect("adapter").value as WebClientAdapter;
  const origin = formInput("origin").value.trim();
  const available = adapter === "hackerspub" && canUseHackersPubPasskey(origin);
  passkeyButton.disabled = !available;
  passkeyButton.title = available
    ? "Start HackersPub passkey login."
    : "HackersPub passkey login requires this page to run on the exact HackersPub origin.";
}

function updateAdapterUi(): void {
  const adapter = formSelect("adapter").value as WebClientAdapter;
  for (const field of document.querySelectorAll<HTMLElement>("[data-hackerspub-login]")) {
    field.hidden = adapter !== "hackerspub";
  }
  updateVisibilityOptions(activeAdapter ?? adapter);
  updatePasskeyButton();
}

function handleAuthFormChange(target: EventTarget | null): void {
  if (isLoginTargetField(target)) {
    const hadActiveClient = activeClient !== undefined;
    beginSessionReset();
    if (hadActiveClient) render("Active session was cleared because the login target changed.");
  }
  updateAdapterUi();
}

function isLoginTargetField(target: EventTarget | null): boolean {
  if (target instanceof HTMLSelectElement) return target.name === "adapter";
  if (!(target instanceof HTMLInputElement)) return false;
  return [
    "clientName",
    "hackersPubChallengeToken",
    "hackersPubCode",
    "hackersPubIdentifier",
    "origin",
    "scopes",
    "sessionToken",
  ].includes(target.name);
}

function updateVisibilityOptions(adapter: WebClientAdapter): void {
  const values = visibilityValues(adapter);
  visibilitySelect.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = visibilityLabel(value);
      return option;
    }),
  );
}

function visibilityValues(adapter: WebClientAdapter): readonly PostVisibilityInput[] {
  if (adapter === "misskey") return ["public", "unlisted", "followers", "direct", "local"];
  if (adapter === "hackerspub") return ["public", "unlisted", "followers", "direct", "none"];
  return ["public", "unlisted", "followers", "direct"];
}

function visibilityLabel(value: PostVisibilityInput): string {
  if (value === "public") return "Public";
  if (value === "unlisted") return "Unlisted";
  if (value === "followers") return "Followers";
  if (value === "direct") return "Direct";
  if (value === "local") return "Local";
  if (value === "none") return "None";
  return value;
}

function lineFor<T>(
  label: string,
  result: PromiseSettledResult<T>,
  format: (value: T) => string,
): string {
  if (result.status === "fulfilled") return `${label}: ${format(result.value)}`;
  return `${label}: unavailable (${errorMessage(result.reason)})`;
}

function renderError(error: unknown): void {
  render(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderResult(target: HTMLElement, message: string): void {
  target.textContent = message;
}
