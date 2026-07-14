import { type StreamConnection } from "@activityplug/core";
import { type Context, type Hono } from "hono";

import {
  readBoundedBodyBytes,
  readBoundedBodyText,
  validateMultipartPayload,
  type RequestLimits,
} from "../security/request-limits.js";
import {
  toBrowserCapabilities,
  toBrowserEntityRef,
  toBrowserMedia,
  toBrowserPost,
  toBrowserPostSummary,
  toBrowserProfile,
  toBrowserProfileSummary,
  toBrowserRelationship,
} from "./dto.js";
import { BrowserBoundaryError } from "./errors.js";
import { type BrowserSessionManager } from "./session.js";
import { consumeStreamTicket, issueStreamTicket } from "./stream-tickets.js";
import {
  type BrowserBoundary,
  type BrowserBoundaryDependencies,
  type BrowserBoundaryOptions,
  type BrowserRequestContext,
} from "./types.js";

export function registerBrowserApiRoutes(input: {
  readonly app: Hono;
  readonly options: BrowserBoundaryOptions & BrowserBoundaryDependencies;
  readonly resolveRequest: BrowserBoundary["resolveRequest"];
  readonly sessions: BrowserSessionManager;
  readonly publicOrigin: string;
  readonly csrfHeaderName: string;
  readonly requestLimits: RequestLimits;
  readonly now: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
}): void {
  const {
    app,
    options,
    resolveRequest,
    sessions,
    publicOrigin,
    csrfHeaderName,
    requestLimits,
    now,
    randomBytes,
  } = input;
  app.get("/v1/browser/api/capabilities", async (context) => {
    const requestContext = await requireAuthenticatedRequest(resolveRequest, context.req.raw);
    const capabilities = await options.service.capabilities(
      withRequestSignal(selectorFor(requestContext), requestContext.signal),
    );
    return context.json({ data: { capabilities: toBrowserCapabilities(capabilities) } });
  });

  app.get("/v1/browser/api/timelines/:kind", async (context) => {
    const requestContext = await requireAuthenticatedRequest(resolveRequest, context.req.raw);
    const page = browserPage(new URL(context.req.url).searchParams);
    const sessionId = requestContext.authSession.id;
    const kind = context.req.param("kind");
    const connection =
      kind === "home"
        ? await options.service.timelines.home(
            withRequestSignal(
              { sessionId, ...(page === undefined ? {} : { page }) },
              requestContext.signal,
            ),
          )
        : kind === "local"
          ? await options.service.timelines.local(
              withRequestSignal(
                {
                  ...selectorFor(requestContext),
                  sessionId,
                  local: true,
                  ...(page === undefined ? {} : { page }),
                },
                requestContext.signal,
              ),
            )
          : kind === "federated"
            ? await options.service.timelines.public(
                withRequestSignal(
                  {
                    ...selectorFor(requestContext),
                    sessionId,
                    local: false,
                    ...(page === undefined ? {} : { page }),
                  },
                  requestContext.signal,
                ),
              )
            : null;
    if (connection === null) {
      throw new BrowserBoundaryError("NOT_FOUND", "Timeline kind was not found.", 404);
    }
    return context.json({
      data: {
        posts: connection.nodes.map(toBrowserPostSummary),
        pageInfo: { nextCursor: connection.pageInfo.endCursor ?? null },
      },
    });
  });

  app.get("/v1/browser/api/search", async (context) => {
    const requestContext = await requireAuthenticatedRequest(resolveRequest, context.req.raw);
    const query = new URL(context.req.url).searchParams;
    const q = requireNonBlank(query.get("q") ?? "", "q");
    const typeValue = query.get("type") ?? "all";
    if (!["all", "accounts", "posts", "hashtags"].includes(typeValue)) {
      throw new BrowserBoundaryError("BAD_REQUEST", "Search type is invalid.", 400);
    }
    const page = browserPage(query);
    const result = await options.service.search.search(
      withRequestSignal(
        {
          ...selectorFor(requestContext),
          sessionId: requestContext.authSession.id,
          query: q,
          ...(typeValue === "all" ? {} : { type: typeValue as "accounts" | "posts" | "hashtags" }),
          ...(page === undefined ? {} : { page }),
        },
        requestContext.signal,
      ),
    );
    return context.json({
      data: {
        accounts: result.accounts.map(toBrowserProfileSummary),
        posts: result.posts.map(toBrowserPostSummary),
        hashtags: result.hashtags.map((hashtag) => ({
          name: hashtag.name,
          ...(hashtag.url === undefined ? {} : { url: hashtag.url }),
          history: (hashtag.history ?? []).map((item) => ({
            day: item.day,
            ...(item.uses === undefined ? {} : { uses: item.uses }),
            ...(item.accounts === undefined ? {} : { accounts: item.accounts }),
          })),
        })),
        pageInfo: { nextCursor: result.pageInfo.endCursor ?? null },
      },
    });
  });

  app.get("/v1/browser/api/profiles/:id", async (context) => {
    const requestContext = await requireAuthenticatedRequest(resolveRequest, context.req.raw);
    const page = browserPage(new URL(context.req.url).searchParams);
    return context.json({
      data: await loadBrowserProfile(requestContext, requirePathId(context, "id"), page),
    });
  });

  registerProfileAction(app, "follow", async (requestContext, id) => {
    await options.service.social.follow(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, accountId: id },
        requestContext.signal,
      ),
    );
  });
  registerProfileAction(app, "unfollow", async (requestContext, id) => {
    await options.service.social.unfollow(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, accountId: id },
        requestContext.signal,
      ),
    );
  });

  app.get("/v1/browser/api/posts/:id", async (context) => {
    const requestContext = await requireAuthenticatedRequest(resolveRequest, context.req.raw);
    const post = await options.service.posts.get(
      withRequestSignal(
        {
          id: requirePathId(context, "id"),
          sessionId: requestContext.authSession.id,
        },
        requestContext.signal,
      ),
    );
    return context.json({ data: { post: toBrowserPost(post) } });
  });

  app.get("/v1/browser/api/posts/:id/context", async (context) => {
    const requestContext = await requireAuthenticatedRequest(resolveRequest, context.req.raw);
    const result = await options.service.posts.context(
      withRequestSignal({ id: requirePathId(context, "id") }, requestContext.signal),
    );
    return context.json({
      data: {
        ancestors: result.ancestors.map(toBrowserPostSummary),
        descendants: result.descendants.map(toBrowserPostSummary),
      },
    });
  });

  app.post("/v1/browser/api/posts", async (context) => {
    const requestContext = await resolveUnsafeAuthenticatedRequest(
      resolveRequest,
      sessions,
      context.req.raw,
      publicOrigin,
      csrfHeaderName,
    );
    const body = parseCreatePost(await readBrowserJson(context.req.raw, requestLimits.jsonBytes));
    const post = await options.service.posts.create(
      withRequestSignal(
        {
          ...selectorFor(requestContext),
          sessionId: requestContext.authSession.id,
          ...body,
        },
        requestContext.signal,
      ),
    );
    return context.json({ data: { post: toBrowserPost(post) } });
  });

  app.post("/v1/browser/api/media", async (context) => {
    const requestContext = await resolveUnsafeAuthenticatedRequest(
      resolveRequest,
      sessions,
      context.req.raw,
      publicOrigin,
      csrfHeaderName,
    );
    const mediaInput = await parseMediaUpload(context.req.raw, requestLimits);
    const media = await options.service.media.upload(
      withRequestSignal(
        {
          ...selectorFor(requestContext),
          sessionId: requestContext.authSession.id,
          ...mediaInput,
        },
        requestContext.signal,
      ),
    );
    return context.json({ data: { media: toBrowserMedia(media) } });
  });

  app.delete("/v1/browser/api/media/:id", async (context) => {
    const requestContext = await resolveUnsafeAuthenticatedRequest(
      resolveRequest,
      sessions,
      context.req.raw,
      publicOrigin,
      csrfHeaderName,
    );
    await assertEmptyBrowserMutation(context.req.raw, requestLimits.jsonBytes);
    await options.service.media.delete(
      withRequestSignal(
        {
          sessionId: requestContext.authSession.id,
          id: requirePathId(context, "id"),
        },
        requestContext.signal,
      ),
    );
    return context.json({ data: { ok: true } });
  });

  registerPostAction(app, "post", "/favourite", (requestContext, postId) =>
    options.service.social.favourite(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, postId },
        requestContext.signal,
      ),
    ),
  );
  registerPostAction(app, "delete", "/favourite", (requestContext, postId) =>
    options.service.social.unfavourite(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, postId },
        requestContext.signal,
      ),
    ),
  );
  registerPostAction(app, "post", "/reblog", (requestContext, postId) =>
    options.service.social.boost(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, postId },
        requestContext.signal,
      ),
    ),
  );
  registerPostAction(app, "delete", "/reblog", (requestContext, postId) =>
    options.service.social.unboost(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, postId },
        requestContext.signal,
      ),
    ),
  );
  registerPostAction(app, "post", "/bookmark", (requestContext, postId) =>
    options.service.social.bookmark(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, postId },
        requestContext.signal,
      ),
    ),
  );
  registerPostAction(app, "delete", "/bookmark", (requestContext, postId) =>
    options.service.social.unbookmark(
      withRequestSignal(
        { sessionId: requestContext.authSession.id, postId },
        requestContext.signal,
      ),
    ),
  );

  app.post("/v1/browser/api/posts/:id/reactions", async (context) => {
    const requestContext = await resolveUnsafeAuthenticatedRequest(
      resolveRequest,
      sessions,
      context.req.raw,
      publicOrigin,
      csrfHeaderName,
    );
    const body = requireObject(
      await readBrowserJson(context.req.raw, requestLimits.jsonBytes),
      "Reaction request",
    );
    rejectCredentialFields(body);
    const post = await options.service.social.react(
      withRequestSignal(
        {
          sessionId: requestContext.authSession.id,
          postId: requirePathId(context, "id"),
          emoji: requireNonBlank(requireString(body, "reaction"), "reaction"),
        },
        requestContext.signal,
      ),
    );
    return context.json({ data: { post: toBrowserPost(post) } });
  });

  app.delete("/v1/browser/api/posts/:id/reactions/:reaction", async (context) => {
    const requestContext = await resolveUnsafeAuthenticatedRequest(
      resolveRequest,
      sessions,
      context.req.raw,
      publicOrigin,
      csrfHeaderName,
    );
    await assertEmptyBrowserMutation(context.req.raw, requestLimits.jsonBytes);
    const post = await options.service.social.unreact(
      withRequestSignal(
        {
          sessionId: requestContext.authSession.id,
          postId: requirePathId(context, "id"),
          emoji: requireNonBlank(context.req.param("reaction"), "reaction"),
        },
        requestContext.signal,
      ),
    );
    return context.json({ data: { post: toBrowserPost(post) } });
  });

  app.post("/v1/browser/stream-tickets", async (context) => {
    const requestContext = await resolveUnsafeAuthenticatedRequest(
      resolveRequest,
      sessions,
      context.req.raw,
      publicOrigin,
      csrfHeaderName,
    );
    const body = requireObject(
      await readBrowserJson(context.req.raw, requestLimits.jsonBytes),
      "Stream ticket request",
    );
    rejectCredentialFields(body);
    rejectDataAuthorityFields(body);
    const operation = requireString(body, "operation");
    if (
      operation !== "stream.timeline" &&
      operation !== "stream.notifications" &&
      operation !== "stream.conversations"
    ) {
      throw new BrowserBoundaryError("BAD_REQUEST", "Stream operation is invalid.", 400);
    }
    const ticket = await issueStreamTicket(options.streamTickets, {
      browserSessionId: requestContext.browserSession.id,
      operation,
      now,
      randomBytes: () => randomBytes(32),
    });
    return context.json({ data: { ticket } });
  });

  app.get("/v1/browser/stream", async (context) => {
    const requestContext = await requireAuthenticatedRequest(resolveRequest, context.req.raw);
    const ticketValue = new URL(context.req.url).searchParams.get("ticket") ?? "";
    const ticket = await consumeStreamTicket(options.streamTickets, ticketValue, now());
    if (ticket === null || ticket.browserSessionId !== requestContext.browserSession.id) {
      throw new BrowserBoundaryError("UNAUTHENTICATED", "Stream ticket is unavailable.", 401);
    }
    const requestSignal = context.req.raw.signal;
    const streamAbort = new AbortController();
    const abortFromRequest = () => streamAbort.abort(requestSignal.reason);
    if (requestSignal.aborted) abortFromRequest();
    else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
    const signal = streamAbort.signal;
    const detach = () => requestSignal.removeEventListener("abort", abortFromRequest);
    let connection: StreamConnection;
    try {
      connection =
        ticket.operation === "stream.timeline"
          ? await options.service.streams.timeline({
              ...selectorFor(requestContext),
              sessionId: requestContext.authSession.id,
              type: "home",
              signal,
            })
          : ticket.operation === "stream.notifications"
            ? await options.service.streams.notifications({
                sessionId: requestContext.authSession.id,
                ...selectorFor(requestContext),
                signal,
              })
            : await options.service.streams.conversations({
                sessionId: requestContext.authSession.id,
                ...selectorFor(requestContext),
                signal,
              });
    } catch (error) {
      detach();
      throw error;
    }
    const encoder = new TextEncoder();
    const iterator = connection[Symbol.asyncIterator]();
    let finalizing: Promise<void> | undefined;
    const finalize = (abort: boolean, reason?: unknown): Promise<void> => {
      finalizing ??= (async () => {
        detach();
        if (abort && !signal.aborted) streamAbort.abort(reason);
        await iterator.return?.();
      })();
      return finalizing;
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (signal.aborted) {
            await finalize(false).catch(() => undefined);
            controller.close();
            return;
          }
          const next = await iterator.next();
          if (next.done) {
            await finalize(false).catch(() => undefined);
            controller.close();
            return;
          }
          const bytes = encoder.encode(
            `data: ${JSON.stringify(toBrowserStreamEvent(next.value))}\n\n`,
          );
          if (bytes.byteLength > requestLimits.websocketBufferedBytes) {
            throw new BrowserBoundaryError(
              "UPSTREAM_FAILURE",
              "Stream event exceeded the configured buffer limit.",
              502,
            );
          }
          controller.enqueue(bytes);
        } catch (error) {
          const aborted = signal.aborted;
          await finalize(!aborted, error).catch(() => undefined);
          if (aborted) controller.close();
          else controller.error(error);
        }
      },
      async cancel(reason) {
        await finalize(true, reason);
      },
    });
    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  });

  function registerProfileAction(
    target: Hono,
    action: "follow" | "unfollow",
    operation: (context: AuthenticatedBrowserRequestContext, id: string) => Promise<void>,
  ): void {
    target.post(`/v1/browser/api/profiles/:id/${action}`, async (context) => {
      const requestContext = await resolveUnsafeAuthenticatedRequest(
        resolveRequest,
        sessions,
        context.req.raw,
        publicOrigin,
        csrfHeaderName,
      );
      await assertEmptyBrowserMutation(context.req.raw, requestLimits.jsonBytes);
      const id = requirePathId(context, "id");
      await operation(requestContext, id);
      return context.json({ data: await loadBrowserProfile(requestContext, id) });
    });
  }

  async function loadBrowserProfile(
    requestContext: AuthenticatedBrowserRequestContext,
    id: string,
    page?: ReturnType<typeof browserPage>,
  ) {
    const [profile, posts, capabilities] = await Promise.all([
      options.service.accounts.get(withRequestSignal({ id }, requestContext.signal)),
      options.service.accounts.posts(
        withRequestSignal(
          {
            id,
            sessionId: requestContext.authSession.id,
            ...(page === undefined ? {} : { page }),
          },
          requestContext.signal,
        ),
      ),
      options.service.capabilities(
        withRequestSignal(selectorFor(requestContext), requestContext.signal),
      ),
    ]);
    const relationship =
      capabilities["accounts.relationships"].status === "supported"
        ? await options.service.social.relationship(
            withRequestSignal(
              { sessionId: requestContext.authSession.id, accountId: id },
              requestContext.signal,
            ),
          )
        : undefined;
    return {
      profile: toBrowserProfile(profile),
      posts: posts.nodes.map(toBrowserPostSummary),
      pageInfo: { nextCursor: posts.pageInfo.endCursor ?? null },
      ...(relationship === undefined ? {} : { relationship: toBrowserRelationship(relationship) }),
    };
  }

  function registerPostAction(
    target: Hono,
    method: "post" | "delete",
    suffix: string,
    operation: (
      context: AuthenticatedBrowserRequestContext,
      postId: string,
    ) => Promise<import("@activityplug/core").Post>,
  ): void {
    target[method](`/v1/browser/api/posts/:id${suffix}`, async (context) => {
      const requestContext = await resolveUnsafeAuthenticatedRequest(
        resolveRequest,
        sessions,
        context.req.raw,
        publicOrigin,
        csrfHeaderName,
      );
      await assertEmptyBrowserMutation(context.req.raw, requestLimits.jsonBytes);
      const post = await operation(requestContext, requirePathId(context, "id"));
      return context.json({ data: { post: toBrowserPost(post) } });
    });
  }
}

export type AuthenticatedBrowserRequestContext = BrowserRequestContext & {
  readonly browserSession: Extract<
    BrowserRequestContext["browserSession"],
    { authenticated: true }
  >;
  readonly authSession: NonNullable<BrowserRequestContext["authSession"]>;
};

export async function requireAuthenticatedRequest(
  resolveRequest: BrowserBoundary["resolveRequest"],
  request: Request,
): Promise<AuthenticatedBrowserRequestContext> {
  const context = await resolveRequest(request);
  if (!context.browserSession.authenticated || context.authSession === null) {
    throw new BrowserBoundaryError("UNAUTHENTICATED", "Authentication is required.", 401);
  }
  return context as AuthenticatedBrowserRequestContext;
}

export async function resolveUnsafeAuthenticatedRequest(
  resolveRequest: BrowserBoundary["resolveRequest"],
  sessions: Pick<BrowserSessionManager, "assertCsrf" | "assertSameOrigin">,
  request: Request,
  publicOrigin: string,
  csrfHeaderName: string,
): Promise<AuthenticatedBrowserRequestContext> {
  const context = await requireAuthenticatedRequest(resolveRequest, request);
  sessions.assertSameOrigin(request, publicOrigin);
  sessions.assertCsrf(request, context.browserSession.csrfTokenHash, csrfHeaderName);
  return context;
}

export function selectorFor(context: AuthenticatedBrowserRequestContext) {
  return { adapter: context.authSession.adapter, origin: context.authSession.origin };
}

export function withRequestSignal<T extends object>(
  input: T,
  signal: AbortSignal,
): T & {
  readonly signal: AbortSignal;
} {
  return { ...input, signal };
}

function toBrowserStreamEvent(event: import("@activityplug/core").StreamEvent) {
  const common = {
    type: event.type,
    stream: event.stream,
    ...(event.id === undefined ? {} : { id: event.id }),
    ...(event.emittedAt === undefined ? {} : { emittedAt: event.emittedAt }),
  };
  if (event.type === "timeline.update" || event.type === "edit") {
    return { ...common, post: toBrowserPost(event.post) };
  }
  if (event.type === "notification") {
    return {
      ...common,
      notification: {
        ref: toBrowserEntityRef(event.notification.ref),
        type: event.notification.type,
        createdAt: event.notification.createdAt,
        account: toBrowserEntityRef(event.notification.account),
        ...(event.notification.post === undefined
          ? {}
          : { post: toBrowserEntityRef(event.notification.post) }),
      },
    };
  }
  if (event.type === "delete") {
    return {
      ...common,
      deleted: { ref: toBrowserEntityRef(event.deleted.ref), deleted: true as const },
    };
  }
  return common;
}

function browserPage(query: URLSearchParams) {
  const cursor = query.get("cursor");
  const limitValue = query.get("limit");
  let limit: number | undefined;
  if (limitValue !== null) {
    if (!/^\d+$/u.test(limitValue)) {
      throw new BrowserBoundaryError("BAD_REQUEST", "Page limit is invalid.", 400);
    }
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BrowserBoundaryError("BAD_REQUEST", "Page limit must be between 1 and 100.", 400);
    }
  }
  if (cursor === null && limit === undefined) return undefined;
  return {
    ...(cursor === null ? {} : { after: requireNonBlank(cursor, "cursor") }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function requirePathId(context: Context, name: string): string {
  return requireNonBlank(context.req.param(name) ?? "", name);
}

function parseCreatePost(value: unknown) {
  const body = requireObject(value, "Create post request");
  rejectCredentialFields(body);
  rejectDataAuthorityFields(body);
  const visibility = optionalString(body, "visibility");
  if (
    visibility !== undefined &&
    !["public", "unlisted", "followers", "direct", "local"].includes(visibility)
  ) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Post visibility is invalid.", 400);
  }
  const mediaIdsValue = body["mediaIds"];
  let mediaIds: readonly string[] | undefined;
  if (mediaIdsValue !== undefined) {
    if (
      !Array.isArray(mediaIdsValue) ||
      mediaIdsValue.some((id) => typeof id !== "string" || id.trim() === "")
    ) {
      throw new BrowserBoundaryError("BAD_REQUEST", "Post mediaIds must be strings.", 400);
    }
    mediaIds = mediaIdsValue;
  }
  const summary = optionalString(body, "summary");
  const replyToId = optionalString(body, "replyToId");
  const quoteOfId = optionalString(body, "quoteOfId");
  const sensitive = optionalBoolean(body, "sensitive");
  const content = requireString(body, "content");
  if (
    content.trim() === "" &&
    (mediaIds === undefined || mediaIds.length === 0) &&
    (replyToId === undefined || replyToId.trim() === "") &&
    (quoteOfId === undefined || quoteOfId.trim() === "")
  ) {
    throw new BrowserBoundaryError(
      "BAD_REQUEST",
      "Post creation requires text, media, a reply target, or a quote target.",
      400,
    );
  }
  return {
    content,
    ...(visibility === undefined
      ? {}
      : {
          visibility: visibility as "public" | "unlisted" | "followers" | "direct" | "local",
        }),
    ...(sensitive === undefined ? {} : { sensitive }),
    ...(summary === undefined ? {} : { summary }),
    ...(replyToId === undefined ? {} : { replyToId }),
    ...(quoteOfId === undefined ? {} : { quoteOfId }),
    ...(mediaIds === undefined ? {} : { mediaIds }),
  };
}

async function parseMediaUpload(request: Request, limits: RequestLimits) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new BrowserBoundaryError(
      "BAD_REQUEST",
      "Media upload must use multipart/form-data.",
      400,
    );
  }
  const bytes = await readBoundedBodyBytes(request, limits.multipartBytes, request.signal);
  const parsedRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: bytes,
  });
  let form: FormData;
  try {
    form = await parsedRequest.formData();
  } catch {
    throw new BrowserBoundaryError("BAD_REQUEST", "Multipart media upload is invalid.", 400);
  }
  const files = [...form.values()].filter((value): value is File => value instanceof File);
  validateMultipartPayload(
    bytes.byteLength,
    files.map((file) => ({
      byteLength: file.size,
      mimeType: file.type || "application/octet-stream",
    })),
    {
      multipartBytes: limits.multipartBytes,
      multipartFiles: limits.multipartFiles,
      multipartFileBytes: limits.multipartFileBytes,
    },
  );
  const file = form.get("file");
  if (!(file instanceof File) || files.length !== 1) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Media upload requires exactly one file.", 400);
  }
  const descriptionValue = form.get("description");
  if (descriptionValue !== null && typeof descriptionValue !== "string") {
    throw new BrowserBoundaryError("BAD_REQUEST", "Media description must be text.", 400);
  }
  return {
    file,
    filename: file.name,
    ...(descriptionValue === null ? {} : { description: descriptionValue }),
  };
}

async function readBrowserJson(request: Request, limit: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must use application/json.", 400);
  }
  const body = await readBoundedBodyText(request, limit, request.signal);
  try {
    return JSON.parse(body);
  } catch {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must contain valid JSON.", 400);
  }
}

async function assertEmptyBrowserMutation(request: Request, limit: number): Promise<void> {
  if (request.body === null) return;
  const bytes = await readBoundedBodyBytes(request, limit, request.signal);
  if (bytes.byteLength === 0) return;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must use application/json.", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must contain valid JSON.", 400);
  }
  const body = requireObject(value, "Mutation request");
  rejectCredentialFields(body);
  rejectDataAuthorityFields(body);
  if (Object.keys(body).length !== 0) {
    throw new BrowserBoundaryError(
      "BAD_REQUEST",
      "Mutation request contains an unsupported field.",
      400,
    );
  }
}

function requireObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowserBoundaryError("BAD_REQUEST", `${label} must be an object.`, 400);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: Readonly<Record<string, unknown>>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must be a string: ${field}.`, 400);
  }
  return fieldValue;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "string") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must be a string: ${field}.`, 400);
  }
  return fieldValue;
}

function optionalBoolean(
  value: Readonly<Record<string, unknown>>,
  field: string,
): boolean | undefined {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "boolean") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must be a boolean: ${field}.`, 400);
  }
  return fieldValue;
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim() === "") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must not be blank: ${field}.`, 400);
  }
  return value;
}

function rejectCredentialFields(value: Readonly<Record<string, unknown>>): void {
  const forbidden = [
    "sessionId",
    "activityPlugSessionId",
    "accessToken",
    "refreshToken",
    "clientSecret",
    "tokenSet",
  ];
  if (forbidden.some((field) => Object.hasOwn(value, field))) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Browser credentials are server-owned.", 400);
  }
}

function rejectDataAuthorityFields(value: Readonly<Record<string, unknown>>): void {
  if (["origin", "adapter"].some((field) => Object.hasOwn(value, field))) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Browser data authority is server-owned.", 400);
  }
}
