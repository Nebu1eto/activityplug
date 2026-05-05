import { type AuthSession } from "../auth/types.js";
import { type DeletedEntity, type Notification, type Post } from "./entities.js";

export type StreamKind = "timeline" | "notifications" | "conversations";

export type TimelineStreamKind = "home" | "public" | "local" | "hashtag" | "list";

export type StreamEvent =
  | TimelineUpdateStreamEvent
  | NotificationStreamEvent
  | DeleteStreamEvent
  | EditStreamEvent
  | FiltersChangedStreamEvent
  | HeartbeatStreamEvent;

export interface StreamEventBase {
  readonly id?: string;
  readonly stream: StreamKind;
  readonly emittedAt?: string;
  readonly raw?: unknown;
}

export interface TimelineUpdateStreamEvent extends StreamEventBase {
  readonly type: "timeline.update";
  readonly stream: "timeline";
  readonly post: Post;
}

export interface NotificationStreamEvent extends StreamEventBase {
  readonly type: "notification";
  readonly stream: "notifications";
  readonly notification: Notification;
}

export interface DeleteStreamEvent extends StreamEventBase {
  readonly type: "delete";
  readonly stream: StreamKind;
  readonly deleted: DeletedEntity;
}

export interface EditStreamEvent extends StreamEventBase {
  readonly type: "edit";
  readonly stream: "timeline";
  readonly post: Post;
}

export interface FiltersChangedStreamEvent extends StreamEventBase {
  readonly type: "filters.changed";
  readonly stream: StreamKind;
}

export interface HeartbeatStreamEvent extends StreamEventBase {
  readonly type: "heartbeat";
  readonly stream: StreamKind;
}

export interface StreamReconnectPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly maxAttempts?: number;
}

export interface StreamOptions {
  readonly signal?: AbortSignal;
}

export interface StreamPageInput {
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface TimelineStreamInput extends StreamOptions {
  readonly session?: AuthSession;
  readonly type: TimelineStreamKind;
  readonly tag?: string;
  readonly listId?: string;
  readonly page?: StreamPageInput;
}

export interface NotificationStreamInput extends StreamOptions {
  readonly session: AuthSession;
}

export interface ConversationStreamInput extends StreamOptions {
  readonly session: AuthSession;
}

export type StreamConnection = AsyncIterable<StreamEvent>;
