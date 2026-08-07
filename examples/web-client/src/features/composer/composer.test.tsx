// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "../../test/setup.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { WebApiError } from "../../api/http.js";
import { composerAtom } from "../../state/composer.js";
import { localeAtom } from "../../state/locale.js";
import { renderApp } from "../../test/render.js";
import { Composer, type ComposerControlDecisions, type CreatePostPort } from "./composer.js";
import { type MediaUploadPort } from "./uploads.js";

it("preserves the draft and held uploads when the post outcome is unknown", async () => {
  const { media, posts } = ports({
    posts: {
      createPost: vi.fn(async () => {
        throw new WebApiError("UPSTREAM_FAILURE", "The upstream request failed.", 502);
      }),
    },
  });
  const user = userEvent.setup();
  const view = renderApp(<Composer media={media} posts={posts} />);

  await user.type(screen.getByLabelText("Post content"), "Hello");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );
  await user.type(screen.getByLabelText("Alt text for cat.png"), "A sleeping cat");

  expect(screen.getByRole("img", { name: "A sleeping cat" })).toHaveAttribute(
    "src",
    "blob:cat.png",
  );
  expect(media.uploadMedia).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Post" }));

  expect(media.uploadMedia).toHaveBeenCalledWith(
    { file: expect.objectContaining({ name: "cat.png" }), description: "A sleeping cat" },
    expect.any(AbortSignal),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The post may have been accepted. Check your timeline before trying again.",
  );
  expect(screen.getByLabelText("Post content")).toHaveValue("Hello");
  expect(screen.getByLabelText("Alt text for cat.png")).toHaveValue("A sleeping cat");
  expect(screen.getByLabelText("Alt text for cat.png")).toHaveAttribute("readonly");

  view.unmount();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(media.deleteMedia).not.toHaveBeenCalled();
});

it("removes unknown-outcome media locally without deleting the potentially attached upload", async () => {
  const { media, posts } = ports({
    posts: {
      createPost: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    },
  });
  const user = userEvent.setup();
  renderApp(<Composer media={media} posts={posts} />);
  await user.type(screen.getByLabelText("Post content"), "Check before retrying");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );

  await user.click(screen.getByRole("button", { name: "Post" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The post may have been accepted. Check your timeline before trying again.",
  );
  await user.click(screen.getByRole("button", { name: "Remove cat.png" }));

  expect(media.deleteMedia).not.toHaveBeenCalled();
  expect(screen.queryByRole("img", { name: "cat.png" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Post content")).toHaveValue("Check before retrying");
});

it.each([
  {
    locale: "en" as const,
    content: "Post content",
    submit: "Post",
    warning: "The post may have been accepted. Check your timeline before trying again.",
  },
  {
    locale: "ko" as const,
    content: "게시물 내용",
    submit: "게시",
    warning: "게시물이 등록되었을 수 있습니다. 다시 시도하기 전에 타임라인을 확인하세요.",
  },
  {
    locale: "ja" as const,
    content: "投稿内容",
    submit: "投稿",
    warning: "投稿が受け付けられた可能性があります。再試行する前にタイムラインを確認してください。",
  },
])("localizes the unknown post outcome warning in $locale", async (copy) => {
  const { media, posts } = ports({
    posts: {
      createPost: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    },
  });
  const user = userEvent.setup();
  renderLocalizedComposer(copy.locale, <Composer media={media} posts={posts} />);
  await user.type(screen.getByLabelText(copy.content), "Outcome unknown");

  await user.click(screen.getByRole("button", { name: copy.submit }));

  expect(await screen.findByRole("alert")).toHaveTextContent(copy.warning);
  expect(posts.createPost).toHaveBeenCalledOnce();
});

it("does not automatically retry an unknown post outcome", async () => {
  const createPost = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  const { media, posts } = ports({ posts: { createPost } });
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 2, retryDelay: 0 } },
  });
  const store = createStore();
  const user = userEvent.setup();
  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <Composer media={media} posts={posts} />
      </QueryClientProvider>
    </JotaiProvider>,
  );
  await user.type(screen.getByLabelText("Post content"), "Do not duplicate");

  await user.click(screen.getByRole("button", { name: "Post" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The post may have been accepted. Check your timeline before trying again.",
  );
  expect(createPost).toHaveBeenCalledOnce();
});

it("retries post creation without uploading successful media again", async () => {
  const createPost = vi
    .fn<CreatePostPort["createPost"]>()
    .mockRejectedValueOnce(new Error("Remote server unavailable"))
    .mockResolvedValueOnce({ id: "post-1" });
  const { media, posts } = ports({ posts: { createPost } });
  const user = userEvent.setup();
  renderApp(<Composer media={media} posts={posts} />);
  await user.type(screen.getByLabelText("Post content"), "Retry me");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );

  await user.click(screen.getByRole("button", { name: "Post" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The post may have been accepted. Check your timeline before trying again.",
  );
  await user.click(screen.getByRole("button", { name: "Post" }));

  await waitFor(() => expect(screen.getByLabelText("Post content")).toHaveValue(""));
  expect(media.uploadMedia).toHaveBeenCalledOnce();
  expect(createPost).toHaveBeenCalledTimes(2);
});

it("submits once across rapid activation and resets only after success", async () => {
  const post = Promise.withResolvers<{ readonly id: string }>();
  const createPost = vi.fn(() => post.promise);
  const onPostCreated = vi.fn();
  const { media, posts } = ports({ posts: { createPost } });
  const user = userEvent.setup();
  renderApp(<Composer media={media} posts={posts} onPostCreated={onPostCreated} />);
  await user.type(screen.getByLabelText("Post content"), "One post");

  const submit = screen.getByRole("button", { name: "Post" });
  await Promise.all([user.click(submit), user.click(submit)]);

  expect(createPost).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Post content")).toHaveValue("One post");

  post.resolve({ id: "post-1" });
  await waitFor(() => expect(screen.getByLabelText("Post content")).toHaveValue(""));
  expect(onPostCreated).toHaveBeenCalledWith({ id: "post-1" });
});

it("clears submitted content and media while preserving a new target chosen in flight", async () => {
  const post = Promise.withResolvers<{ readonly id: string }>();
  const createPost = vi.fn(() => post.promise);
  const { media, posts } = ports({ posts: { createPost } });
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const store = createStore();
  const user = userEvent.setup();
  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <Composer media={media} posts={posts} />
      </QueryClientProvider>
    </JotaiProvider>,
  );
  await user.type(screen.getByLabelText("Post content"), "Already submitted");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );
  await user.click(screen.getByRole("button", { name: "Post" }));
  await waitFor(() => expect(createPost).toHaveBeenCalledOnce());

  act(() => {
    store.set(composerAtom, (current) => ({
      ...current,
      replyToId: "new-reply-target",
      quoteOfId: undefined,
    }));
  });
  post.resolve({ id: "post-1" });

  await waitFor(() => expect(screen.getByLabelText("Post content")).toHaveValue(""));
  expect(store.get(composerAtom)).toMatchObject({
    content: "",
    replyToId: "new-reply-target",
    attachments: [],
  });
  expect(media.deleteMedia).not.toHaveBeenCalled();
});

it("sends visibility, content warning, sensitivity, reply, and quote fields", async () => {
  const { media, posts } = ports();
  const user = userEvent.setup();
  renderApp(<Composer media={media} posts={posts} replyToId="reply-1" quoteOfId="quote-1" />);

  await user.type(screen.getByLabelText("Post content"), "Contextual post");
  await user.selectOptions(screen.getByLabelText("Visibility"), "followers");
  await user.click(screen.getByRole("button", { name: "Content warning" }));
  await user.type(screen.getByLabelText("Content warning", { selector: "input" }), "Spoilers");
  await user.click(screen.getByLabelText("Mark media as sensitive"));
  await user.click(screen.getByRole("button", { name: "Post" }));

  expect(posts.createPost).toHaveBeenCalledWith({
    content: "Contextual post",
    visibility: "followers",
    summary: "Spoilers",
    sensitive: true,
    replyToId: "reply-1",
    quoteOfId: "quote-1",
    mediaIds: [],
  });
});

it("keeps rendered capability controls described without untargeted reasons", () => {
  const { media, posts } = ports();
  const controls: ComposerControlDecisions = {
    contentWarning: { enabled: false, reason: "Warnings are unavailable." },
    quote: { enabled: false, reason: "Quotes are disabled." },
    reply: { enabled: false, reason: "Replies are disabled." },
    visibility: { enabled: false, reason: "Visibility is fixed." },
  };
  renderApp(<Composer controls={controls} media={media} posts={posts} />);

  expect(screen.getByLabelText("Visibility")).toBeDisabled();
  expect(screen.getByLabelText("Visibility")).toHaveAccessibleDescription("Visibility is fixed.");
  expect(screen.getByLabelText("Content warning", { selector: "input" })).toBeDisabled();
  expect(
    screen.getByLabelText("Content warning", { selector: "input" }),
  ).toHaveAccessibleDescription("Warnings are unavailable.");
  expect(screen.queryByLabelText("Reply to post")).not.toBeInTheDocument();
  expect(screen.queryByText("Replies are disabled.")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Quote post")).not.toBeInTheDocument();
  expect(screen.queryByText("Quotes are disabled.")).not.toBeInTheDocument();
});

it("clears an incompatible HackersPub warning and sensitive draft", async () => {
  const { media, posts } = ports();
  const store = createStore();
  store.set(composerAtom, {
    attachments: [],
    content: "A draft that must remain editable",
    sensitive: true,
    summary: "Unsupported warning",
    visibility: "public",
  });
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <Composer
          controls={{
            contentWarning: { enabled: false },
            sensitive: { enabled: false },
          }}
          media={media}
          posts={posts}
          supportedVisibilities={["followers"]}
        />
      </QueryClientProvider>
    </JotaiProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText("Visibility")).toHaveValue("followers"));
  expect(screen.getByLabelText("Content warning", { selector: "input" })).toHaveValue("");
  expect(screen.getByLabelText("Mark media as sensitive")).not.toBeChecked();
  expect(screen.getByLabelText("Post content")).toHaveValue("A draft that must remain editable");
});

it("clears an incompatible Misskey sensitive draft without removing its warning", async () => {
  const { media, posts } = ports();
  const store = createStore();
  store.set(composerAtom, {
    attachments: [],
    content: "A persisted Misskey draft",
    sensitive: true,
    summary: "A supported warning",
    visibility: "public",
  });
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <Composer
          controls={{ sensitive: { enabled: false } }}
          media={media}
          posts={posts}
          supportedVisibilities={["public", "unlisted", "followers", "direct", "local"]}
        />
      </QueryClientProvider>
    </JotaiProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText("Mark media as sensitive")).not.toBeChecked());
  expect(screen.getByLabelText("Content warning", { selector: "input" })).toHaveValue(
    "A supported warning",
  );
  expect(screen.getByLabelText("Post content")).toHaveValue("A persisted Misskey draft");
});

it("exposes upload failure, retry, indeterminate progress, and cancellation", async () => {
  const first = Promise.withResolvers<{ readonly id: string; readonly remoteUrl: string }>();
  const uploadMedia = vi
    .fn<MediaUploadPort["uploadMedia"]>()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce({ id: "media-1", remoteUrl: "https://cdn.test/cat.png" });
  const { media, posts } = ports({ media: { uploadMedia } });
  const user = userEvent.setup();
  renderApp(<Composer media={media} posts={posts} />);
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );

  await user.click(screen.getByRole("button", { name: "Upload cat.png" }));
  expect(screen.getByRole("progressbar", { name: "Uploading cat.png" })).not.toHaveAttribute(
    "value",
  );
  await user.click(screen.getByRole("button", { name: "Cancel upload for cat.png" }));
  first.reject(new DOMException("Aborted", "AbortError"));

  expect(await screen.findByRole("button", { name: "Retry upload for cat.png" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Retry upload for cat.png" }));
  expect(await screen.findByText("Uploaded cat.png")).toBeVisible();
});

it("can cancel a submit-triggered upload before post creation", async () => {
  const uploadMedia = vi.fn<MediaUploadPort["uploadMedia"]>(
    (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const { media, posts } = ports({ media: { uploadMedia } });
  const user = userEvent.setup();
  renderApp(<Composer media={media} posts={posts} />);
  await user.type(screen.getByLabelText("Post content"), "Wait for the image");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );

  await user.click(screen.getByRole("button", { name: "Post" }));
  const cancel = await screen.findByRole("button", { name: "Cancel upload for cat.png" });
  expect(cancel).toBeEnabled();
  await user.click(cancel);

  expect(await screen.findByRole("alert")).toHaveTextContent("Upload cancelled.");
  expect(posts.createPost).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Post content")).toHaveValue("Wait for the image");
});

it("preserves uploaded media and reports remote cleanup failure", async () => {
  const deleteMedia = vi.fn(async () => {
    throw new Error("Could not remove remote media");
  });
  const { media, posts } = ports({ media: { deleteMedia } });
  const user = userEvent.setup();
  renderApp(<Composer media={media} posts={posts} />);
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );
  await user.click(screen.getByRole("button", { name: "Upload cat.png" }));
  await screen.findByText("Uploaded cat.png");

  await user.click(screen.getByRole("button", { name: "Remove cat.png" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove remote media");
  expect(screen.getByRole("img", { name: "cat.png" })).toBeVisible();
});

it("does not delete media committed by a successful post", async () => {
  const { media, posts } = ports();
  const user = userEvent.setup();
  const view = renderApp(<Composer media={media} posts={posts} />);
  await user.type(screen.getByLabelText("Post content"), "Keep the upload");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );
  await user.click(screen.getByRole("button", { name: "Post" }));
  await waitFor(() => expect(screen.getByLabelText("Post content")).toHaveValue(""));

  view.unmount();

  expect(media.deleteMedia).not.toHaveBeenCalled();
});

it("holds uploaded media while post creation survives an unmount", async () => {
  const post = Promise.withResolvers<{ readonly id: string }>();
  const createPost = vi.fn(() => post.promise);
  const { media, posts } = ports({ posts: { createPost } });
  const user = userEvent.setup();
  const view = renderApp(<Composer media={media} posts={posts} />);
  await user.type(screen.getByLabelText("Post content"), "Finish after navigation");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );
  await user.click(screen.getByRole("button", { name: "Post" }));
  await waitFor(() => expect(createPost).toHaveBeenCalledOnce());

  view.unmount();
  await Promise.resolve();
  expect(media.deleteMedia).not.toHaveBeenCalled();

  post.resolve({ id: "post-1" });
  await waitFor(() => expect(media.deleteMedia).not.toHaveBeenCalled());
});

it.each([
  new WebApiError("BAD_REQUEST", "Post content is invalid.", 400),
  new WebApiError("UNAUTHENTICATED", "Authentication has expired.", 401),
])("releases held media after the definite failure $code", async (failure) => {
  const post = Promise.withResolvers<{ readonly id: string }>();
  const createPost = vi.fn(() => post.promise);
  const { media, posts } = ports({ posts: { createPost } });
  const user = userEvent.setup();
  const view = renderApp(<Composer media={media} posts={posts} />);
  await user.type(screen.getByLabelText("Post content"), "Fail after navigation");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );
  await user.click(screen.getByRole("button", { name: "Post" }));
  await waitFor(() => expect(createPost).toHaveBeenCalledOnce());

  view.unmount();
  await Promise.resolve();
  expect(media.deleteMedia).not.toHaveBeenCalled();
  post.reject(failure);

  await waitFor(() => expect(media.deleteMedia).toHaveBeenCalledWith("media-1"));
});

it("revokes previews without persisting unusable attachments after unmount", async () => {
  const { media, posts } = ports();
  const store = createStore();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const user = userEvent.setup();
  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <Composer media={media} posts={posts} />
      </QueryClientProvider>
    </JotaiProvider>,
  );
  await user.type(screen.getByLabelText("Post content"), "Preserve this text");
  await user.upload(
    screen.getByLabelText("Add images", { selector: "input" }),
    imageFile("cat.png", 10),
  );
  expect(store.get(composerAtom).attachments).toHaveLength(1);

  view.unmount();

  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cat.png"));
  expect(store.get(composerAtom)).toMatchObject({
    content: "Preserve this text",
    attachments: [],
  });
});

Object.defineProperties(URL, {
  createObjectURL: {
    configurable: true,
    value: vi.fn((file: File) => `blob:${file.name}`),
  },
  revokeObjectURL: { configurable: true, value: vi.fn() },
});

beforeEach(() => {
  vi.mocked(URL.createObjectURL).mockClear();
  vi.mocked(URL.createObjectURL).mockImplementation((file) => `blob:${(file as File).name}`);
  vi.mocked(URL.revokeObjectURL).mockClear();
});

function imageFile(name: string, size: number, type = "image/png"): File {
  const file = new File([], name, { type });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

function renderLocalizedComposer(locale: "en" | "ko" | "ja", ui: ReactElement): void {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const store = createStore();
  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </JotaiProvider>,
  );
  act(() => store.set(localeAtom, locale));
}

function ports(
  overrides: {
    readonly media?: Partial<MediaUploadPort>;
    readonly posts?: Partial<CreatePostPort>;
  } = {},
): {
  readonly media: MediaUploadPort;
  readonly posts: CreatePostPort;
} {
  return {
    media: {
      uploadMedia: vi.fn(async () => ({
        id: "media-1",
        remoteUrl: "https://cdn.test/media-1.png",
      })),
      deleteMedia: vi.fn(async () => undefined),
      ...overrides.media,
    },
    posts: {
      createPost: vi.fn(async () => ({ id: "post-1" })),
      ...overrides.posts,
    },
  };
}
