import { exchangeAuth, startAuth, type StartedAuth, type WebClientAdapter } from "./index.js";

import appStyles from "./app.css?inline";

interface StoredStartedAuth extends Omit<StartedAuth, "authorizationUrl" | "fetch"> {
  readonly authorizationUrl: string;
}

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("Missing app root.");
const style = document.createElement("style");
style.textContent = appStyles;
document.head.append(style);

const stateKey = "activityplug.web-client.startedAuth";

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
        Search query
        <input name="query" value="activityplug" />
      </label>
      <div class="actions">
        <button type="submit">Start OAuth</button>
        <button type="button" id="clear-session">Clear session</button>
      </div>
    </form>
    <section id="output" aria-live="polite"></section>
  </section>
`;

const output = element("#output", HTMLElement);
const form = element("#auth-form", HTMLFormElement);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void beginAuth(new FormData(form));
});

element("#clear-session", HTMLButtonElement).addEventListener("click", () => {
  sessionStorage.removeItem(stateKey);
  render("Stored OAuth state was cleared.");
});

void resumeCallback();

async function beginAuth(formData: FormData): Promise<void> {
  try {
    const redirectUri = callbackUrl();
    const startedAuth = await startAuth({
      adapter: formValue(formData, "adapter") as WebClientAdapter,
      origin: formValue(formData, "origin"),
      clientName: formValue(formData, "clientName"),
      redirectUri,
      scopes: formValue(formData, "scopes").split(/\s+/u).filter(Boolean),
      state: crypto.randomUUID(),
      website: location.origin,
    });
    sessionStorage.setItem(stateKey, JSON.stringify(serializeStartedAuth(startedAuth)));
    location.assign(startedAuth.authorizationUrl.href);
  } catch (error) {
    renderError(error);
  }
}

async function resumeCallback(): Promise<void> {
  const callback = new URL(location.href);
  if (!callback.searchParams.has("code") && !callback.searchParams.has("error")) {
    render("Ready.");
    return;
  }
  const stored = sessionStorage.getItem(stateKey);
  if (stored === null) {
    render("No stored OAuth state was found for this callback.");
    return;
  }
  try {
    const startedAuth = deserializeStartedAuth(JSON.parse(stored) as StoredStartedAuth);
    const client = await exchangeAuth({
      startedAuth,
      callback,
      redirectUri: callbackUrl(),
    });
    history.replaceState(null, "", callbackUrl());
    const [viewer, instance, publicTimeline, localTimeline, search] = await Promise.all([
      client.verifyViewer(),
      client.detectInstance(),
      client.renderPublicTimeline(),
      client.renderLocalTimeline(),
      client.search(formInput("query").value || "activityplug", "posts"),
    ]);
    render(
      [
        `Logged in as ${viewer.acct}.`,
        `Instance: ${instance.software.name} ${instance.software.version ?? ""}`.trim(),
        `Public timeline posts: ${publicTimeline.nodes.length}`,
        `Local timeline posts: ${localTimeline.nodes.length}`,
        `Search posts: ${search.posts.length}`,
      ].join("\n"),
    );
  } catch (error) {
    renderError(error);
  }
}

function serializeStartedAuth(startedAuth: StartedAuth): StoredStartedAuth {
  return {
    adapter: startedAuth.adapter,
    origin: startedAuth.origin,
    client: startedAuth.client,
    authorizationUrl: startedAuth.authorizationUrl.href,
    state: startedAuth.state,
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
  return {
    ...stored,
    authorizationUrl: new URL(stored.authorizationUrl),
  };
}

function callbackUrl(): string {
  return `${location.origin}${location.pathname}`;
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing form value: ${name}`);
  }
  return value.trim();
}

function formInput(name: string): HTMLInputElement {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${name}`);
  return input;
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

function renderError(error: unknown): void {
  render(error instanceof Error ? error.message : String(error));
}
