import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import {
  ActivityPlugError,
  createActivityPlugClient,
  createCapabilitySet,
  createOAuthPkcePair,
  decodeOpaqueId,
  parseOAuthCallback,
  type ActivityPlugAdapter,
  type AuthSession,
  type StoredAuthSession,
} from "@activityplug/core";
import { serve, type ServerType } from "@hono/node-server";
import { getLogger } from "@logtape/logtape";
import { type Hono } from "hono";
import { type cors } from "hono/cors";

import {
  createDefaultApiService,
  type ActivityPlugApiService,
  type InstanceSelector,
  type RelationshipRequest,
  type PostActionRequest,
} from "../api/service.js";
import { createAuthEndpointHandlers } from "../auth/endpoints.js";
import { InMemoryAuthSessionStore, type AuthSessionStore } from "../auth/session-store.js";
import { createActivityPlugApp } from "../http/app.js";
import { type TokenImportOptions } from "../http/app.js";
import {
  assertExchangeTarget,
  consumeOAuthCallbackState,
  InMemoryOAuthClientSecretStore,
  isInMemoryOAuthClientSecretStore,
  type OAuthClientSecretStore,
  requireOAuthCallbackStateBinding,
  sameBinding,
  storeOAuthCallbackState,
} from "./oauth-state.js";

export interface ActivityPlugServerOptions {
  readonly adapters: readonly ActivityPlugAdapter[];
  readonly sessions?: AuthSessionStore;
  readonly cors?: Parameters<typeof cors>[0];
  readonly tokenImport?: TokenImportOptions;
  readonly originPolicy?: OriginFetchPolicy;
  readonly oauthClientSecrets?: OAuthClientSecretStore;
}

export interface StartServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly service?: ActivityPlugApiService;
  readonly cors?: Parameters<typeof cors>[0];
  readonly app?: Hono;
  readonly tokenImport?: TokenImportOptions;
}

export interface ActivityPlugServer {
  readonly app: Hono;
  readonly service: ActivityPlugApiService;
  readonly start: (options: ConstructedServerStartOptions) => StartedServer;
}

export interface ConstructedServerStartOptions {
  readonly hostname: string;
  readonly port: number;
}

export interface StartedServer {
  readonly server: ServerType;
  readonly hostname: string;
  readonly port: number;
}

export interface OriginFetchPolicyContext {
  readonly origin: string;
  readonly operation: string;
}

export type OriginFetchPolicy = (context: OriginFetchPolicyContext) => Promise<void> | void;

export function createActivityPlugServer(options: ActivityPlugServerOptions): ActivityPlugServer {
  const service = createAdapterBackedApiService(options);
  const app = createActivityPlugApp({
    service,
    cors: options.cors,
    tokenImport: options.tokenImport,
  });
  return {
    app,
    service,
    start: (startOptions) =>
      startActivityPlugServer({ ...startOptions, service, cors: options.cors, app }),
  };
}

export function startActivityPlugServer(options: StartServerOptions): StartedServer {
  assertRuntimeOptions(options);
  const logger = getLogger(["activityplug", "server"]);
  const service = options.service ?? createDefaultApiService(createCapabilitySet());
  const app =
    options.app ??
    createActivityPlugApp({
      service,
      cors: options.cors,
      tokenImport: options.tokenImport,
    });
  const server = serve(
    {
      fetch: app.fetch,
      hostname: options.hostname,
      port: options.port,
    },
    (address) => {
      logger.info("ActivityPlug server started on {hostname}:{port}.", {
        hostname: address.address,
        port: address.port,
      });
    },
  );
  return { server, hostname: options.hostname, port: options.port };
}

export function assertRuntimeOptions(options: StartServerOptions): void {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new RangeError("Server port must be an integer between 0 and 65535.");
  }
  if (options.hostname.trim() === "") {
    throw new RangeError("Server hostname must not be empty.");
  }
}

function createAdapterBackedApiService(options: ActivityPlugServerOptions): ActivityPlugApiService {
  const sessions = options.sessions ?? new InMemoryAuthSessionStore();
  const originPolicy = options.originPolicy ?? defaultOriginFetchPolicy;
  const oauthClientSecrets = options.oauthClientSecrets ?? new InMemoryOAuthClientSecretStore();
  if (
    options.sessions !== undefined &&
    (options.oauthClientSecrets === undefined ||
      isInMemoryOAuthClientSecretStore(options.oauthClientSecrets)) &&
    hasDurableStorage(options.sessions)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Durable auth session stores require a matching OAuth client secret store.",
      { operation: "server.create" },
    );
  }
  const adaptersById = new Map(options.adapters.map((adapter) => [adapter.metadata.id, adapter]));
  return {
    health: () => ({ ok: true, version: "v1" }),
    capabilities: async (input) => {
      const selector = normalizeSelector(input, "capabilities");
      await originPolicy({ origin: selector.origin, operation: "capabilities" });
      return (await detectInstance(selector, options.adapters, sessions)).capabilities;
    },
    instances: {
      detect: async (input) => {
        const selector = normalizeSelector(input, "instance.detect");
        await originPolicy({ origin: selector.origin, operation: "instance.detect" });
        return detectInstance(selector, options.adapters, sessions);
      },
      get: async (input) => {
        const selector = normalizeSelector(input, "instance.get");
        await originPolicy({ origin: selector.origin, operation: "instance.get" });
        return resolveClient(selector, options.adapters, sessions).instances.getProfile({
          origin: selector.origin,
        });
      },
    },
    accounts: {
      get: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "account.get");
        await originPolicy({ origin: ref.origin, operation: "account.get" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).accounts.getById({ id: input.id });
      },
      lookup: async (input) => {
        const selector = normalizeSelector(input, "account.lookup");
        await originPolicy({ origin: selector.origin, operation: "account.lookup" });
        return resolveClient(selector, options.adapters, sessions).accounts.getByHandle({
          handle: input.handle,
        });
      },
      posts: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "account.posts");
        await originPolicy({ origin: ref.origin, operation: "account.posts" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "account.posts");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).accounts.listPosts({
          accountId: input.id,
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session }),
        });
      },
    },
    posts: {
      get: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "post.get");
        await originPolicy({ origin: ref.origin, operation: "post.get" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).posts.get(input);
      },
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const selector = normalizeSelector(input, "post.create");
        const session = await requireSession(sessionId, sessions, "post.create");
        await originPolicy({ origin: selector.origin, operation: "post.create" });
        assertSessionTarget(session, selector, "post.create");
        return resolveClient(selector, options.adapters, sessions).posts.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...update } = input;
        const session = await requireSession(sessionId, sessions, "post.update");
        const ref = decodeOpaqueIdForOperation(input.id, "post.update");
        assertInputTarget(input, ref, "post.update");
        await originPolicy({ origin: ref.origin, operation: "post.update" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "post.update");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).posts.update({ ...update, session: toPublicSession(session) });
      },
      history: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "post.history");
        await originPolicy({ origin: ref.origin, operation: "post.history" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "post.history");
        if (session !== undefined) {
          assertSessionTarget(
            session,
            { adapter: ref.adapter, origin: ref.origin },
            "post.history",
          );
        }
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).posts.history({
          id: input.id,
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      delete: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "post.delete");
        const ref = decodeOpaqueIdForOperation(input.id, "post.delete");
        await originPolicy({ origin: ref.origin, operation: "post.delete" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "post.delete");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).posts.delete({
          session: toPublicSession(session),
          id: input.id,
        });
      },
    },
    timelines: {
      home: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "timeline.home");
        const selector =
          input.origin === undefined
            ? { adapter: session.adapter, origin: session.origin }
            : normalizeSelector(
                {
                  origin: input.origin,
                  ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
                },
                "timeline.home",
              );
        assertSessionTarget(session, selector, "timeline.home");
        await originPolicy({ origin: selector.origin, operation: "timeline.home" });
        return handlersClientForSession(session, options.adapters, sessions).timelines.home({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      public: async (input) => {
        const selector = normalizeSelector(input, "timeline.public");
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "timeline.public");
        if (session !== undefined) assertSessionTarget(session, selector, "timeline.public");
        await originPolicy({ origin: selector.origin, operation: "timeline.public" });
        return resolveClient(selector, options.adapters, sessions).timelines.public({
          local: input.local,
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      local: async (input) => {
        const selector = normalizeSelector(input, "timeline.local");
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "timeline.local");
        if (session !== undefined) assertSessionTarget(session, selector, "timeline.local");
        await originPolicy({ origin: selector.origin, operation: "timeline.local" });
        return resolveClient(selector, options.adapters, sessions).timelines.local({
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      hashtag: async (input) => {
        const selector = normalizeSelector(input, "timeline.hashtag");
        await originPolicy({ origin: selector.origin, operation: "timeline.hashtag" });
        return resolveClient(selector, options.adapters, sessions).timelines.hashtag({
          tag: input.tag,
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "timeline.list");
        const ref = decodeOpaqueIdForOperation(input.id, "timeline.list");
        await originPolicy({ origin: ref.origin, operation: "timeline.list" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "timeline.list");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).timelines.list({
          listId: input.id,
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
    },
    search: {
      search: async (input) => {
        const selector = normalizeSelector(input, "search");
        await originPolicy({ origin: selector.origin, operation: "search" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "search");
        if (session !== undefined) assertSessionTarget(session, selector, "search");
        return resolveClient(selector, options.adapters, sessions).search.search({
          query: input.query,
          type: input.type,
          resolve: input.resolve,
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
    },
    media: {
      upload: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...upload } = input;
        const selector = normalizeSelector(input, "media.upload");
        const session = await requireSession(sessionId, sessions, "media.upload");
        await originPolicy({ origin: selector.origin, operation: "media.upload" });
        assertSessionTarget(session, selector, "media.upload");
        return resolveClient(selector, options.adapters, sessions).media.upload({
          ...upload,
          session: toPublicSession(session),
        });
      },
    },
    polls: {
      get: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "poll.get");
        await originPolicy({ origin: ref.origin, operation: "poll.get" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "poll.get");
        if (session !== undefined) {
          assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "poll.get");
        }
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).polls.get({
          id: input.id,
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      vote: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "poll.vote");
        const ref = decodeOpaqueIdForOperation(input.id, "poll.vote");
        await originPolicy({ origin: ref.origin, operation: "poll.vote" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "poll.vote");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).polls.vote({
          session: toPublicSession(session),
          pollId: input.id,
          choices: input.choices,
        });
      },
    },
    social: {
      relationship: (input) =>
        socialAccountAction(
          input,
          "account.relationships",
          sessions,
          options,
          (client, session, accountId) => client.social.relationship({ session, accountId }),
        ),
      follow: (input) =>
        socialAccountAction(
          input,
          "social.follow",
          sessions,
          options,
          (client, session, accountId) => client.social.follow({ session, accountId }),
        ),
      unfollow: (input) =>
        socialAccountAction(
          input,
          "social.unfollow",
          sessions,
          options,
          (client, session, accountId) => client.social.unfollow({ session, accountId }),
        ),
      block: (input) =>
        socialAccountAction(
          input,
          "social.block",
          sessions,
          options,
          (client, session, accountId) => client.social.block({ session, accountId }),
        ),
      unblock: (input) =>
        socialAccountAction(
          input,
          "social.unblock",
          sessions,
          options,
          (client, session, accountId) => client.social.unblock({ session, accountId }),
        ),
      mute: (input) =>
        socialAccountAction(input, "social.mute", sessions, options, (client, session, accountId) =>
          client.social.mute({
            session,
            accountId,
            notifications: input.notifications,
            durationSeconds: input.durationSeconds,
          }),
        ),
      unmute: (input) =>
        socialAccountAction(
          input,
          "social.unmute",
          sessions,
          options,
          (client, session, accountId) => client.social.unmute({ session, accountId }),
        ),
      favourite: (input) =>
        socialPostAction(input, "social.favourite", sessions, options, (client, session, postId) =>
          client.social.favourite({ session, postId }),
        ),
      unfavourite: (input) =>
        socialPostAction(
          input,
          "social.unfavourite",
          sessions,
          options,
          (client, session, postId) => client.social.unfavourite({ session, postId }),
        ),
      bookmark: (input) =>
        socialPostAction(input, "social.bookmark", sessions, options, (client, session, postId) =>
          client.social.bookmark({ session, postId }),
        ),
      unbookmark: (input) =>
        socialPostAction(input, "social.unbookmark", sessions, options, (client, session, postId) =>
          client.social.unbookmark({ session, postId }),
        ),
      boost: (input) =>
        socialPostAction(input, "social.boost", sessions, options, (client, session, postId) =>
          client.social.boost({ session, postId, visibility: input.visibility }),
        ),
      unboost: (input) =>
        socialPostAction(input, "social.unboost", sessions, options, (client, session, postId) =>
          client.social.unboost({ session, postId }),
        ),
      react: (input) =>
        socialPostAction(input, "social.reaction", sessions, options, (client, session, postId) =>
          client.social.react({ session, postId, emoji: input.emoji }),
        ),
      unreact: (input) =>
        socialPostAction(input, "social.unreaction", sessions, options, (client, session, postId) =>
          client.social.unreact({ session, postId, emoji: input.emoji }),
        ),
    },
    notifications: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.list");
        const selector = selectorForSessionInput(input, session, "notification.list");
        await originPolicy({ origin: selector.origin, operation: "notification.list" });
        assertSessionTarget(session, selector, "notification.list");
        return resolveClient(selector, options.adapters, sessions).notifications.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(input.types === undefined ? {} : { types: input.types }),
        });
      },
      unreadCount: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.unreadCount");
        const selector = selectorForSessionInput(input, session, "notification.unreadCount");
        await originPolicy({ origin: selector.origin, operation: "notification.unreadCount" });
        assertSessionTarget(session, selector, "notification.unreadCount");
        return resolveClient(selector, options.adapters, sessions).notifications.unreadCount({
          session: toPublicSession(session),
        });
      },
      dismiss: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.dismiss");
        const ref = decodeOpaqueIdForOperation(input.id, "notification.dismiss");
        await originPolicy({ origin: ref.origin, operation: "notification.dismiss" });
        assertSessionTarget(
          session,
          { adapter: ref.adapter, origin: ref.origin },
          "notification.dismiss",
        );
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).notifications.dismiss({ session: toPublicSession(session), id: input.id });
      },
      clear: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.clear");
        const selector = selectorForSessionInput(input, session, "notification.clear");
        await originPolicy({ origin: selector.origin, operation: "notification.clear" });
        assertSessionTarget(session, selector, "notification.clear");
        await resolveClient(selector, options.adapters, sessions).notifications.clear({
          session: toPublicSession(session),
        });
      },
    },
    lists: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "list.list");
        const selector = selectorForSessionInput(input, session, "list.list");
        await originPolicy({ origin: selector.origin, operation: "list.list" });
        assertSessionTarget(session, selector, "list.list");
        return resolveClient(selector, options.adapters, sessions).lists.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      get: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "list.get");
        const ref = decodeOpaqueIdForOperation(input.id, "list.get");
        await originPolicy({ origin: ref.origin, operation: "list.get" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "list.get");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).lists.get({
          session: toPublicSession(session),
          id: input.id,
        });
      },
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const session = await requireSession(sessionId, sessions, "list.create");
        const selector = selectorForSessionInput(input, session, "list.create");
        await originPolicy({ origin: selector.origin, operation: "list.create" });
        assertSessionTarget(session, selector, "list.create");
        return resolveClient(selector, options.adapters, sessions).lists.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...update } = input;
        const session = await requireSession(sessionId, sessions, "list.update");
        const ref = decodeOpaqueIdForOperation(input.id, "list.update");
        assertInputTarget(input, ref, "list.update");
        await originPolicy({ origin: ref.origin, operation: "list.update" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "list.update");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).lists.update({
          ...update,
          session: toPublicSession(session),
        });
      },
      delete: async (input) =>
        listIdAction(input, "list.delete", sessions, options, (client, session, id) =>
          client.lists.delete({ session, id }),
        ),
      accounts: async (input) =>
        listIdAction(input, "list.accounts", sessions, options, (client, session, id) =>
          client.lists.listAccounts({ session, listId: id, page: input.page }),
        ),
      addAccount: async (input) =>
        listAccountAction(
          input,
          "list.account.add",
          sessions,
          options,
          (client, session, listId, accountId) =>
            client.lists.addAccount({ session, listId, accountId }),
        ),
      removeAccount: async (input) =>
        listAccountAction(
          input,
          "list.account.remove",
          sessions,
          options,
          (client, session, listId, accountId) =>
            client.lists.removeAccount({ session, listId, accountId }),
        ),
      timeline: async (input) =>
        listIdAction(input, "timeline.list", sessions, options, (client, session, id) =>
          client.timelines.list({ session, listId: id, page: input.page }),
        ),
    },
    followRequests: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "followRequest.list");
        const selector = selectorForSessionInput(input, session, "followRequest.list");
        await originPolicy({ origin: selector.origin, operation: "followRequest.list" });
        assertSessionTarget(session, selector, "followRequest.list");
        return resolveClient(selector, options.adapters, sessions).followRequests.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      accept: (input) =>
        socialAccountAction(
          input,
          "followRequest.accept",
          sessions,
          options,
          (client, session, accountId) => client.followRequests.accept({ session, accountId }),
        ),
      reject: (input) =>
        socialAccountAction(
          input,
          "followRequest.reject",
          sessions,
          options,
          (client, session, accountId) => client.followRequests.reject({ session, accountId }),
        ),
    },
    filters: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "filter.list");
        const selector = selectorForSessionInput(input, session, "filter.list");
        await originPolicy({ origin: selector.origin, operation: "filter.list" });
        assertSessionTarget(session, selector, "filter.list");
        return resolveClient(selector, options.adapters, sessions).filters.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      get: async (input) =>
        filterIdAction(input, "filter.get", sessions, options, (client, session, id) =>
          client.filters.get({ session, id }),
        ),
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const session = await requireSession(sessionId, sessions, "filter.create");
        const selector = selectorForSessionInput(input, session, "filter.create");
        await originPolicy({ origin: selector.origin, operation: "filter.create" });
        assertSessionTarget(session, selector, "filter.create");
        return resolveClient(selector, options.adapters, sessions).filters.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...update } = input;
        const session = await requireSession(sessionId, sessions, "filter.update");
        const ref = decodeOpaqueIdForOperation(input.id, "filter.update");
        assertInputTarget(input, ref, "filter.update");
        await originPolicy({ origin: ref.origin, operation: "filter.update" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "filter.update");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).filters.update({
          ...update,
          session: toPublicSession(session),
        });
      },
      delete: async (input) =>
        filterIdAction(input, "filter.delete", sessions, options, (client, session, id) =>
          client.filters.delete({ session, id }),
        ),
    },
    scheduledPosts: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "scheduledPost.list");
        const selector = selectorForSessionInput(input, session, "scheduledPost.list");
        await originPolicy({ origin: selector.origin, operation: "scheduledPost.list" });
        assertSessionTarget(session, selector, "scheduledPost.list");
        return resolveClient(selector, options.adapters, sessions).scheduledPosts.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      get: async (input) =>
        scheduledPostIdAction(
          input,
          "scheduledPost.get",
          sessions,
          options,
          (client, session, id) => client.scheduledPosts.get({ session, id }),
        ),
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const session = await requireSession(sessionId, sessions, "scheduledPost.create");
        const selector = selectorForSessionInput(input, session, "scheduledPost.create");
        await originPolicy({ origin: selector.origin, operation: "scheduledPost.create" });
        assertSessionTarget(session, selector, "scheduledPost.create");
        return resolveClient(selector, options.adapters, sessions).scheduledPosts.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) =>
        scheduledPostIdAction(
          input,
          "scheduledPost.update",
          sessions,
          options,
          (client, session, id) =>
            client.scheduledPosts.update({ session, id, scheduledAt: input.scheduledAt }),
        ),
      delete: async (input) =>
        scheduledPostIdAction(
          input,
          "scheduledPost.delete",
          sessions,
          options,
          (client, session, id) => client.scheduledPosts.delete({ session, id }),
        ),
    },
    auth: {
      importToken: async (input) => {
        const { adapter: _adapter, origin: _origin, ...token } = input;
        const selector = normalizeSelector(input, "auth.tokenInjection");
        await originPolicy({ origin: selector.origin, operation: "auth.tokenInjection" });
        return handlersFor(selector, options.adapters, sessions).importToken(token);
      },
      start: async (input) => {
        const { adapter: _adapter, origin: _origin, ...start } = input;
        const selector = normalizeSelector(input, "auth.oauth.authorizationUrl");
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.authorizationUrl" });
        const adapter = resolveAdapter(selector.adapter, options.adapters);
        const pkce = start.codeChallenge === undefined ? await createOAuthPkcePair() : undefined;
        const result = await handlersFor(selector, options.adapters, sessions).start({
          ...start,
          ...(pkce === undefined
            ? {}
            : { codeChallenge: pkce.codeChallenge, codeChallengeMethod: pkce.codeChallengeMethod }),
        });
        const callbackBinding = {
          adapter: adapter.metadata.id,
          origin: selector.origin,
          clientRequestId: randomUUID(),
        };
        const codeVerifier = result.authorization.codeVerifier ?? pkce?.codeVerifier;
        await storeOAuthCallbackState(
          sessions,
          {
            state: result.authorization.state,
            binding: callbackBinding,
            client: result.client,
            redirectUri: input.redirectUri,
            ...(codeVerifier === undefined ? {} : { codeVerifier }),
          },
          oauthClientSecrets,
        );
        return { ...result, callbackBinding };
      },
      parseCallback: (input) => parseOAuthCallback(input),
      exchange: async (input) => {
        const { adapter: _adapter, origin: _origin, ...exchange } = input;
        const selector = normalizeSelector(input, "auth.oauth.exchangeCode");
        const canonicalInput = { ...input, ...selector };
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.exchangeCode" });
        const adapter = resolveAdapter(selector.adapter, options.adapters);
        if ("callback" in input) {
          const registeredBinding = await requireOAuthCallbackStateBinding(
            sessions,
            input.expectedState,
          );
          if (!sameBinding(registeredBinding, input.expectedBinding)) {
            throw new ActivityPlugError(
              "VALIDATION_FAILED",
              "OAuth callback binding is not registered for this authorization state.",
              {
                adapter: input.expectedBinding.adapter,
                origin: input.expectedBinding.origin,
                operation: "auth.oauth.callback",
              },
            );
          }
          if (!sameBinding(registeredBinding, input.actualBinding)) {
            throw new ActivityPlugError(
              "VALIDATION_FAILED",
              "OAuth callback binding does not match this server instance.",
              {
                adapter: input.actualBinding.adapter,
                origin: input.actualBinding.origin,
                operation: "auth.oauth.callback",
              },
            );
          }
          assertExchangeTarget(canonicalInput, adapter.metadata.id, registeredBinding);
          const state = await consumeOAuthCallbackState(
            sessions,
            input.expectedState,
            oauthClientSecrets,
          );
          return handlersFor(selector, options.adapters, sessions).exchange({
            ...exchange,
            client: state.client,
            redirectUri: state.redirectUri,
            ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
          });
        }
        if (input.state === undefined) {
          throw new ActivityPlugError(
            "VALIDATION_FAILED",
            "OAuth code exchange requires a server-issued state.",
            {
              adapter: input.adapter,
              origin: input.origin,
              operation: "auth.oauth.exchangeCode",
            },
          );
        }
        const registeredBinding = await requireOAuthCallbackStateBinding(sessions, input.state);
        assertExchangeTarget(canonicalInput, adapter.metadata.id, registeredBinding);
        const state = await consumeOAuthCallbackState(sessions, input.state, oauthClientSecrets);
        return handlersFor(selector, options.adapters, sessions).exchange({
          ...exchange,
          client: state.client,
          redirectUri: state.redirectUri,
          ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
        });
      },
      refresh: async (input) => {
        const { adapter: _adapter, origin: _origin, ...refresh } = input;
        const selector = normalizeSelector(input, "auth.oauth.refresh");
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.refresh" });
        return handlersFor(selector, options.adapters, sessions).refresh(refresh);
      },
      refreshSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.refresh");
        await originPolicy({ origin: session.origin, operation: "auth.oauth.refresh" });
        return handlersFor(session, options.adapters, sessions).refresh({
          session: toPublicSession(session),
        });
      },
      revoke: async (input) => {
        const { adapter: _adapter, origin: _origin, ...revoke } = input;
        const selector = normalizeSelector(input, "auth.oauth.revoke");
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.revoke" });
        return handlersFor(selector, options.adapters, sessions).revoke(revoke);
      },
      revokeSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.revoke");
        await originPolicy({ origin: session.origin, operation: "auth.oauth.revoke" });
        await handlersFor(session, options.adapters, sessions).revoke({
          session: toPublicSession(session),
        });
      },
    },
    viewer: async (input) => {
      const session = await requireSession(input.sessionId, sessions, "viewer");
      await originPolicy({ origin: session.origin, operation: "viewer" });
      const adapter = adaptersById.get(session.adapter);
      if (adapter === undefined) {
        throw new ActivityPlugError(
          "ADAPTER_NOT_FOUND",
          `No adapter is registered for ${session.adapter}.`,
          {
            adapter: session.adapter,
            origin: session.origin,
            operation: "viewer",
          },
        );
      }
      return createAuthEndpointHandlers(
        createActivityPlugClient({
          adapter,
          origin: session.origin,
          sessionStore: sessions,
        }),
      ).viewer(toPublicSession(session));
    },
  };
}

function normalizeSelector(input: InstanceSelector, operation: string): InstanceSelector {
  return {
    ...input,
    origin: normalizeServerOrigin(input.origin, operation, input.adapter),
  };
}

function normalizeServerOrigin(
  origin: string,
  operation: string,
  adapter: string | undefined,
): string {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ActivityPlugError("VALIDATION_FAILED", "Origin must use HTTP or HTTPS.", {
        ...(adapter === undefined ? {} : { adapter }),
        origin,
        operation,
      });
    }
    return url.origin;
  } catch (cause) {
    if (cause instanceof ActivityPlugError) throw cause;
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Origin must be an absolute URL.",
      { ...(adapter === undefined ? {} : { adapter }), origin, operation },
      { cause },
    );
  }
}

async function requireSession(sessionId: string, sessions: AuthSessionStore, operation: string) {
  const session = await sessions.get(sessionId);
  if (session === null || session.metadata?.activityplugKind === "oauth-callback-state") {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session is not available.", {
      operation,
    });
  }
  return session;
}

async function detectInstance(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
) {
  if (input.adapter !== undefined) {
    return resolveClient(input, adapters, sessions).instances.detect({ origin: input.origin });
  }
  const failures: unknown[] = [];
  for (const adapter of adapters) {
    try {
      const profile = await createActivityPlugClient({
        adapter,
        origin: input.origin,
        sessionStore: sessions,
      }).instances.detect({ origin: input.origin });
      if (matchesDetectedSoftware(adapter, profile.software.name)) return profile;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1 && failures[0] instanceof ActivityPlugError) {
    throw failures[0];
  }
  throw new ActivityPlugError(
    "ADAPTER_NOT_FOUND",
    "No registered adapter matched the detected instance.",
    {
      origin: input.origin,
      operation: "instance.detect",
    },
  );
}

function matchesDetectedSoftware(adapter: ActivityPlugAdapter, softwareName: string): boolean {
  const normalized = normalizeAdapterName(softwareName);
  return (
    normalizeAdapterName(adapter.metadata.id) === normalized ||
    normalizeAdapterName(adapter.metadata.kind) === normalized ||
    adapter.metadata.supportedSoftware.some(
      (software) => normalizeAdapterName(software) === normalized,
    )
  );
}

function handlersFor(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
) {
  return createAuthEndpointHandlers(resolveClient(input, adapters, sessions));
}

function resolveClient(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
) {
  const adapter = resolveAdapter(input.adapter, adapters);
  return createActivityPlugClient({
    adapter,
    origin: input.origin,
    sessionStore: sessions,
  });
}

function handlersClientForSession(
  session: StoredAuthSession,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
) {
  return resolveClient({ adapter: session.adapter, origin: session.origin }, adapters, sessions);
}

function decodeOpaqueIdForOperation(
  id: string,
  operation: string,
): ReturnType<typeof decodeOpaqueId> {
  try {
    return decodeOpaqueId(id);
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "VALIDATION_FAILED") {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        error.message,
        { ...error.context, operation },
        { cause: error },
      );
    }
    throw error;
  }
}

async function socialAccountAction<Output>(
  input: RelationshipRequest,
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    accountId: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const ref = decodeOpaqueIdForOperation(input.accountId, operation);
  await (options.originPolicy ?? defaultOriginFetchPolicy)({ origin: ref.origin, operation });
  assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, operation);
  return action(
    resolveClient({ adapter: ref.adapter, origin: ref.origin }, options.adapters, sessions),
    toPublicSession(session),
    input.accountId,
  );
}

async function socialPostAction<Output>(
  input: PostActionRequest,
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    postId: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const ref = decodeOpaqueIdForOperation(input.postId, operation);
  await (options.originPolicy ?? defaultOriginFetchPolicy)({ origin: ref.origin, operation });
  assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, operation);
  return action(
    resolveClient({ adapter: ref.adapter, origin: ref.origin }, options.adapters, sessions),
    toPublicSession(session),
    input.postId,
  );
}

function selectorForSessionInput(
  input: { readonly adapter?: string; readonly origin?: string },
  session: StoredAuthSession,
  operation: string,
): InstanceSelector {
  return normalizeSelector(
    {
      adapter: input.adapter ?? session.adapter,
      origin: input.origin ?? session.origin,
    },
    operation,
  );
}

async function listIdAction<Output>(
  input: { readonly id: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    id: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const ref = decodeOpaqueIdForOperation(input.id, operation);
  await (options.originPolicy ?? defaultOriginFetchPolicy)({ origin: ref.origin, operation });
  assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, operation);
  return action(
    resolveClient({ adapter: ref.adapter, origin: ref.origin }, options.adapters, sessions),
    toPublicSession(session),
    input.id,
  );
}

async function filterIdAction<Output>(
  input: { readonly id: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    id: string,
  ) => Promise<Output>,
): Promise<Output> {
  return listIdAction(input, operation, sessions, options, action);
}

async function scheduledPostIdAction<Output>(
  input: { readonly id: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    id: string,
  ) => Promise<Output>,
): Promise<Output> {
  return listIdAction(input, operation, sessions, options, action);
}

async function listAccountAction<Output>(
  input: { readonly id: string; readonly accountId: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    listId: string,
    accountId: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const list = decodeOpaqueIdForOperation(input.id, operation);
  const account = decodeOpaqueIdForOperation(input.accountId, operation);
  if (list.adapter !== account.adapter || list.origin !== account.origin) {
    throw new ActivityPlugError("VALIDATION_FAILED", "List and account IDs must share a target.", {
      adapter: list.adapter,
      origin: list.origin,
      operation,
    });
  }
  await (options.originPolicy ?? defaultOriginFetchPolicy)({ origin: list.origin, operation });
  assertSessionTarget(session, { adapter: list.adapter, origin: list.origin }, operation);
  return action(
    resolveClient({ adapter: list.adapter, origin: list.origin }, options.adapters, sessions),
    toPublicSession(session),
    input.id,
    input.accountId,
  );
}

function assertSessionTarget(
  session: StoredAuthSession,
  selector: InstanceSelector,
  operation: string,
): void {
  if (
    (selector.adapter !== undefined && session.adapter !== selector.adapter) ||
    session.origin !== selector.origin
  ) {
    throw new ActivityPlugError(
      "AUTH_REQUIRED",
      "Auth session does not belong to this operation target.",
      {
        adapter: selector.adapter,
        origin: selector.origin,
        operation,
      },
    );
  }
}

function assertInputTarget(
  input: { readonly adapter?: string; readonly origin?: string },
  selector: InstanceSelector,
  operation: string,
): void {
  const inputOrigin =
    input.origin === undefined ? undefined : normalizeInputOrigin(input.origin, operation);
  if (
    (input.adapter !== undefined && input.adapter !== selector.adapter) ||
    (inputOrigin !== undefined && inputOrigin !== selector.origin)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Input target does not match the entity identifier.",
      {
        adapter: selector.adapter,
        origin: selector.origin,
        operation,
      },
    );
  }
}

function normalizeInputOrigin(origin: string, operation: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    throw new ActivityPlugError("VALIDATION_FAILED", "Input origin must be a valid URL.", {
      origin,
      operation,
    });
  }
}

function resolveAdapter(
  adapterName: string | undefined,
  adapters: readonly ActivityPlugAdapter[],
): ActivityPlugAdapter {
  if (adapterName === undefined) {
    if (adapters.length === 1) {
      const adapter = adapters[0];
      if (adapter !== undefined) return adapter;
    }
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Adapter must be provided when more than one adapter is registered.",
    );
  }
  const normalized = normalizeAdapterName(adapterName);
  const adapter = adapters.find(
    (candidate) =>
      normalizeAdapterName(candidate.metadata.id) === normalized ||
      normalizeAdapterName(candidate.metadata.kind) === normalized,
  );
  if (adapter === undefined) {
    throw new ActivityPlugError(
      "ADAPTER_NOT_FOUND",
      `No adapter is registered for ${adapterName}.`,
      {
        adapter: adapterName,
      },
    );
  }
  return adapter;
}

function normalizeAdapterName(adapterName: string): string {
  return adapterName.toLowerCase().replaceAll("_", "-");
}

function toPublicSession(session: AuthSession): AuthSession {
  return {
    id: session.id,
    adapter: session.adapter,
    origin: session.origin,
    ...(session.account === undefined ? {} : { account: session.account }),
    scopes: session.scopes,
    capabilities: session.capabilities,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  };
}

async function defaultOriginFetchPolicy(context: OriginFetchPolicyContext): Promise<void> {
  const url = parseServerFetchOrigin(context);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw blockedOrigin(context, "Server-side remote fetches require an HTTP or HTTPS origin.");
  }
  if (isBlockedHostname(url.hostname)) {
    throw blockedOrigin(context, "Server-side remote fetch origin resolves to a private host.");
  }
  throw blockedOrigin(
    context,
    "Server-side remote fetches require an explicit origin policy for this server.",
  );
}

function parseServerFetchOrigin(context: OriginFetchPolicyContext): URL {
  try {
    return new URL(context.origin);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Origin must be an absolute URL.",
      { origin: context.origin, operation: context.operation },
      { cause },
    );
  }
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isBlockedIpAddress(normalized)
  );
}

function isBlockedIpAddress(address: string): boolean {
  const normalizedAddress = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const mappedIpv4 = ipv4MappedAddress(normalizedAddress);
  if (mappedIpv4 !== undefined) return isBlockedIpAddress(mappedIpv4);
  const family = isIP(normalizedAddress);
  if (family === 0) return false;
  if (family === 6) {
    const firstHextet = Number.parseInt(normalizedAddress.split(":")[0] ?? "", 16);
    return (
      normalizedAddress === "::1" ||
      normalizedAddress === "::" ||
      normalizedAddress.startsWith("100:") ||
      normalizedAddress.startsWith("2001:2:") ||
      normalizedAddress.startsWith("2001:db8:") ||
      normalizedAddress.startsWith("fc") ||
      normalizedAddress.startsWith("fd") ||
      (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
      (firstHextet >= 0xff00 && firstHextet <= 0xffff)
    );
  }
  const octets = normalizedAddress.split(".").map((part) => Number(part));
  const [first = 0, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function ipv4MappedAddress(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (dotted !== undefined) return dotted;
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function blockedOrigin(context: OriginFetchPolicyContext, message: string): ActivityPlugError {
  return new ActivityPlugError("VALIDATION_FAILED", message, {
    origin: context.origin,
    operation: context.operation,
  });
}

function hasDurableStorage(sessions: AuthSessionStore): boolean {
  return !(sessions instanceof InMemoryAuthSessionStore);
}
