import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  type ChangeEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n/i18n.js";
import {
  BookmarkIcon,
  BoostIcon,
  FavouriteIcon,
  QuoteIcon,
  ReactIcon,
  ReplyIcon,
} from "./action-icons.js";
import {
  controlDecision,
  type CapabilityCollection,
  type CapabilityControl,
  type CapabilityTranslator,
  type ControlDecision,
} from "./capability.js";

export interface PostReference {
  readonly id: string;
  readonly type: "post";
}

export interface PostViewerReaction {
  readonly emoji: string;
  readonly count?: number;
  readonly me: boolean;
}

export interface PostViewerState {
  readonly favourited?: boolean;
  readonly boosted?: boolean;
  readonly bookmarked?: boolean;
  readonly reactions?: readonly PostViewerReaction[];
}

export interface PostCounts {
  readonly reblogs?: number;
  readonly favourites?: number;
}

export interface ActionablePost {
  readonly ref: PostReference;
  readonly counts?: PostCounts;
  readonly viewerState?: PostViewerState;
}

export type PostActionInput =
  | { readonly kind: "favourite" | "reblog" | "bookmark"; readonly enabled: boolean }
  | {
      readonly kind: "reaction";
      readonly enabled: boolean;
      readonly reaction: string;
    };

export interface PostActionResponse<Post extends ActionablePost = ActionablePost> {
  readonly post: Post;
}

export type PostActionPort<Post extends ActionablePost = ActionablePost> = (
  id: string,
  input: PostActionInput,
) => Promise<PostActionResponse<Post>>;

export interface PostActionLabels {
  readonly group: string;
  readonly reply: string;
  readonly quote: string;
  readonly favourite: string;
  readonly unfavourite: string;
  readonly boost: string;
  readonly unboost: string;
  readonly bookmark: string;
  readonly unbookmark: string;
  readonly reaction: string;
  readonly react: string;
  readonly unreact: string;
  readonly reactionRequired: string;
  readonly actionFailed: string;
}

export interface PostActionsProps<Post extends ActionablePost = ActionablePost> {
  readonly post: Post;
  readonly capabilities: CapabilityCollection;
  readonly actOnPost: PostActionPort<Post>;
  readonly onQuote: (id: string) => void;
  readonly onReply: (id: string) => void;
  readonly labels?: Partial<PostActionLabels>;
  readonly translateCapability?: CapabilityTranslator;
}

interface CachedPostSnapshot<Post extends ActionablePost> {
  readonly queryKey: QueryKey;
  readonly previous: readonly Post[];
  readonly optimistic: readonly Post[];
}

interface PostMutationContext<Post extends ActionablePost> {
  readonly id: string;
  readonly version: number;
  readonly snapshots: readonly CachedPostSnapshot<Post>[];
}

interface PostMutationVariables {
  readonly id: string;
  readonly input: PostActionInput;
}

const postMutationVersions = new WeakMap<QueryClient, Map<string, number>>();
const postActionQueues = new WeakMap<QueryClient, Map<string, Promise<void>>>();

export function PostActions<Post extends ActionablePost>({
  actOnPost,
  capabilities,
  labels: labelOverrides,
  onQuote,
  onReply,
  post,
  translateCapability,
}: PostActionsProps<Post>): ReactElement {
  const { t } = useI18n();
  const labels: PostActionLabels = {
    group: t("post.actions"),
    reply: t("post.reply"),
    quote: t("post.quote"),
    favourite: t("post.favourite"),
    unfavourite: t("post.unfavourite"),
    boost: t("post.boost"),
    unboost: t("post.unboost"),
    bookmark: t("post.bookmark"),
    unbookmark: t("post.unbookmark"),
    reaction: t("post.reaction"),
    react: t("post.react"),
    unreact: t("post.unreact"),
    reactionRequired: t("post.reactionRequired"),
    actionFailed: t("post.actionFailed"),
    ...labelOverrides,
  };
  const queryClient = useQueryClient();
  const [reaction, setReaction] = useState("");
  const mutation = useMutation<
    PostActionResponse<Post>,
    Error,
    PostMutationVariables,
    PostMutationContext<Post>
  >({
    mutationFn: ({ id, input }) => enqueuePostAction(queryClient, id, () => actOnPost(id, input)),
    onMutate: async ({ id, input }) => {
      const version = beginPostMutation(queryClient, id);
      try {
        return {
          id,
          snapshots: await optimisticallyUpdatePost(queryClient, id, input),
          version,
        };
      } catch (error) {
        finishPostMutation(queryClient, id, version);
        throw error;
      }
    },
    onError: (_error, _variables, context) => {
      if (context !== undefined && isLatestPostMutation(queryClient, context.id, context.version)) {
        rollBackPost(queryClient, context.id, context);
      }
    },
    onSuccess: (response, { input }, context) => {
      if (isLatestPostMutation(queryClient, context.id, context.version)) {
        replacePostAfterSuccess(queryClient, context.id, response.post);
      }
      if (input.kind === "reaction") setReaction("");
    },
    onSettled: async (_data, _error, _variables, context) => {
      if (
        context === undefined ||
        !isLatestPostMutation(queryClient, context.id, context.version)
      ) {
        return;
      }
      try {
        await queryClient.invalidateQueries({
          predicate: (query) =>
            cacheValueContainsPost(query.state.data, context.id) ||
            queryKeyContainsId(query.queryKey, context.id),
        });
      } finally {
        finishPostMutation(queryClient, context.id, context.version);
      }
    },
    retry: false,
  });

  const viewerState = post.viewerState ?? {};
  const reactionValue = reaction.trim();
  const reacted =
    reactionValue !== "" &&
    viewerState.reactions?.some((item) => item.me && item.emoji === reaction) === true;
  const runAction = (input: PostActionInput): void => {
    mutation.reset();
    mutation.mutate({ id: post.ref.id, input });
  };

  return (
    <div
      aria-busy={mutation.isPending}
      aria-label={labels.group}
      className="post-actions"
      role="group"
    >
      <div className="post-actions__row">
        <CapabilityAction
          control="reply"
          decision={controlDecision(capabilities, "reply", translateCapability ?? t)}
          label={labels.reply}
          onActivate={() => onReply(post.ref.id)}
          pending={false}
        />
        <CapabilityAction
          control="quote"
          decision={controlDecision(capabilities, "quote", translateCapability ?? t)}
          label={labels.quote}
          onActivate={() => onQuote(post.ref.id)}
          pending={false}
        />
        <CapabilityAction
          active={viewerState.favourited === true}
          control="favourite"
          count={post.counts?.favourites}
          decision={controlDecision(capabilities, "favourite", translateCapability ?? t)}
          label={viewerState.favourited === true ? labels.unfavourite : labels.favourite}
          onActivate={() =>
            runAction({ kind: "favourite", enabled: viewerState.favourited !== true })
          }
          pending={mutation.isPending}
        />
        <CapabilityAction
          active={viewerState.boosted === true}
          control="boost"
          count={post.counts?.reblogs}
          decision={controlDecision(capabilities, "boost", translateCapability ?? t)}
          label={viewerState.boosted === true ? labels.unboost : labels.boost}
          onActivate={() => runAction({ kind: "reblog", enabled: viewerState.boosted !== true })}
          pending={mutation.isPending}
        />
        <CapabilityAction
          active={viewerState.bookmarked === true}
          control="bookmark"
          decision={controlDecision(capabilities, "bookmark", translateCapability ?? t)}
          label={viewerState.bookmarked === true ? labels.unbookmark : labels.bookmark}
          onActivate={() =>
            runAction({ kind: "bookmark", enabled: viewerState.bookmarked !== true })
          }
          pending={mutation.isPending}
        />
        <ReactionAction
          decision={controlDecision(capabilities, "reaction", translateCapability ?? t)}
          labels={labels}
          onChange={setReaction}
          onSubmit={() => {
            if (reactionValue === "") return;
            runAction({
              kind: "reaction",
              enabled: !reacted,
              reaction,
            });
          }}
          pending={mutation.isPending}
          reacted={reacted}
          value={reaction}
        />
      </div>
      {mutation.error === null ? null : (
        <p className="form-message form-message--error" role="alert">
          {errorMessage(mutation.error, labels.actionFailed)}
        </p>
      )}
    </div>
  );
}

interface CapabilityActionProps {
  readonly active?: boolean;
  readonly control: Extract<
    CapabilityControl,
    "reply" | "quote" | "favourite" | "boost" | "bookmark"
  >;
  readonly count?: number;
  readonly decision: ControlDecision;
  readonly label: string;
  readonly onActivate: () => void;
  readonly pending: boolean;
}

const actionIcons: Record<CapabilityActionProps["control"], () => ReactElement> = {
  bookmark: BookmarkIcon,
  boost: BoostIcon,
  favourite: FavouriteIcon,
  quote: QuoteIcon,
  reply: ReplyIcon,
};

function CapabilityAction({
  active,
  control,
  count,
  decision,
  label,
  onActivate,
  pending,
}: CapabilityActionProps): ReactElement {
  const tooltip = useActionReasonTooltip(decision.enabled ? undefined : decision.reason);
  const ActionIcon = actionIcons[control];
  return (
    <div className="post-actions__control" data-post-action={control}>
      <button
        aria-describedby={tooltip.descriptionId}
        aria-disabled={decision.enabled ? undefined : true}
        aria-label={label}
        aria-pressed={active}
        disabled={decision.enabled && pending}
        onBlur={tooltip.onBlur}
        onClick={() => {
          if (decision.enabled) onActivate();
        }}
        onFocus={tooltip.onFocus}
        onPointerEnter={tooltip.onPointerEnter}
        onPointerLeave={tooltip.onPointerLeave}
        ref={tooltip.triggerRef}
        type="button"
      >
        <ActionIcon />
        {count === undefined ? null : (
          <span aria-hidden="true" className="post-actions__count">
            {count}
          </span>
        )}
      </button>
      {tooltip.element}
    </div>
  );
}

interface ReactionActionProps {
  readonly decision: ControlDecision;
  readonly labels: PostActionLabels;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly pending: boolean;
  readonly reacted: boolean;
  readonly value: string;
}

function ReactionAction({
  decision,
  labels,
  onChange,
  onSubmit,
  pending,
  reacted,
  value,
}: ReactionActionProps): ReactElement {
  const blank = value.trim() === "";
  const reason = decision.enabled ? (blank ? labels.reactionRequired : undefined) : decision.reason;
  const tooltip = useActionReasonTooltip(reason);
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(event.currentTarget.value);
  };

  return (
    <div className="post-actions__control post-actions__reaction" data-post-action="reaction">
      {decision.enabled ? (
        <input
          aria-label={labels.reaction}
          aria-describedby={tooltip.descriptionId}
          disabled={pending}
          onChange={handleChange}
          type="text"
          value={value}
        />
      ) : null}
      <button
        aria-describedby={tooltip.descriptionId}
        aria-disabled={decision.enabled ? undefined : true}
        aria-label={reacted ? labels.unreact : labels.react}
        aria-pressed={reacted}
        disabled={decision.enabled && (pending || blank)}
        onBlur={tooltip.onBlur}
        onClick={() => {
          if (decision.enabled) onSubmit();
        }}
        onFocus={tooltip.onFocus}
        onPointerEnter={tooltip.onPointerEnter}
        onPointerLeave={tooltip.onPointerLeave}
        ref={tooltip.triggerRef}
        type="button"
      >
        <ReactIcon />
      </button>
      {tooltip.element}
    </div>
  );
}

function useActionReasonTooltip(reason: string | undefined): {
  readonly descriptionId: string | undefined;
  readonly element: ReactElement | null;
  readonly onBlur: () => void;
  readonly onFocus: () => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
} {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState({ left: 0, placement: "below", top: 0 });
  const visible = reason !== undefined && (focused || hovered);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (trigger === null || tooltip === null) return;

    const viewportPadding = 8;
    const tooltipGap = 6;
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const spaceAbove = triggerRect.top;
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const placement =
      spaceAbove >= tooltipRect.height + tooltipGap || spaceAbove > spaceBelow ? "above" : "below";
    const preferredTop =
      placement === "above"
        ? triggerRect.top - tooltipRect.height - tooltipGap
        : triggerRect.bottom + tooltipGap;
    const preferredLeft = triggerRect.left;
    const maximumTop = Math.max(
      viewportPadding,
      window.innerHeight - tooltipRect.height - viewportPadding,
    );
    const maximumLeft = Math.max(
      viewportPadding,
      window.innerWidth - tooltipRect.width - viewportPadding,
    );

    setPosition({
      left: Math.min(Math.max(preferredLeft, viewportPadding), maximumLeft),
      placement,
      top: Math.min(Math.max(preferredTop, viewportPadding), maximumTop),
    });
  }, []);

  useLayoutEffect(() => {
    if (visible) updatePosition();
  }, [updatePosition, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition, visible]);

  const element =
    reason === undefined || typeof document === "undefined"
      ? null
      : createPortal(
          <span
            className="post-actions__tooltip"
            data-placement={position.placement}
            data-visible={visible ? "true" : "false"}
            id={id}
            ref={tooltipRef}
            role="tooltip"
            style={{ left: position.left, top: position.top }}
          >
            {reason}
          </span>,
          document.body,
        );

  return {
    descriptionId: reason === undefined ? undefined : id,
    element,
    onBlur: () => setFocused(false),
    onFocus: () => setFocused(true),
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
    triggerRef,
  };
}

async function optimisticallyUpdatePost<Post extends ActionablePost>(
  queryClient: QueryClient,
  id: string,
  input: PostActionInput,
): Promise<readonly CachedPostSnapshot<Post>[]> {
  const affectedQueries = queryClient
    .getQueryCache()
    .findAll({ predicate: (query) => cacheValueContainsPost(query.state.data, id) });
  await Promise.all(
    affectedQueries.map((query) =>
      queryClient.cancelQueries({ exact: true, queryKey: query.queryKey }),
    ),
  );

  const snapshots: CachedPostSnapshot<Post>[] = [];
  for (const query of affectedQueries) {
    const current = queryClient.getQueryData(query.queryKey);
    const previous = collectPosts(current, id) as readonly Post[];
    queryClient.setQueryData(query.queryKey, (value: unknown) =>
      replacePosts(value, id, (candidate) => applyOptimisticAction(candidate as Post, input)),
    );
    snapshots.push({
      queryKey: query.queryKey,
      previous,
      optimistic: collectPosts(queryClient.getQueryData(query.queryKey), id) as readonly Post[],
    });
  }
  return snapshots;
}

function beginPostMutation(queryClient: QueryClient, id: string): number {
  let versions = postMutationVersions.get(queryClient);
  if (versions === undefined) {
    versions = new Map();
    postMutationVersions.set(queryClient, versions);
  }
  const version = (versions.get(id) ?? 0) + 1;
  versions.set(id, version);
  return version;
}

function isLatestPostMutation(queryClient: QueryClient, id: string, version: number): boolean {
  return postMutationVersions.get(queryClient)?.get(id) === version;
}

function finishPostMutation(queryClient: QueryClient, id: string, version: number): void {
  const versions = postMutationVersions.get(queryClient);
  if (versions?.get(id) !== version) return;
  versions.delete(id);
  if (versions.size === 0) postMutationVersions.delete(queryClient);
}

async function enqueuePostAction<Result>(
  queryClient: QueryClient,
  id: string,
  action: () => Promise<Result>,
): Promise<Result> {
  let queues = postActionQueues.get(queryClient);
  if (queues === undefined) {
    queues = new Map();
    postActionQueues.set(queryClient, queues);
  }
  const previous = queues.get(id) ?? Promise.resolve();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const tail = previous.then(() => gate);
  queues.set(id, tail);

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(id) === tail) {
      queues.delete(id);
      if (queues.size === 0) postActionQueues.delete(queryClient);
    }
  }
}

function rollBackPost<Post extends ActionablePost>(
  queryClient: QueryClient,
  id: string,
  context: PostMutationContext<Post>,
): void {
  for (const snapshot of context.snapshots) {
    const existing = queryClient.getQueryCache().find({ exact: true, queryKey: snapshot.queryKey });
    if (existing === undefined) continue;
    let index = 0;
    queryClient.setQueryData(snapshot.queryKey, (value: unknown) =>
      replacePosts(value, id, (candidate) => {
        const currentIndex = index;
        index += 1;
        return candidate === snapshot.optimistic[currentIndex]
          ? (snapshot.previous[currentIndex] ?? candidate)
          : candidate;
      }),
    );
  }
}

function replacePostAfterSuccess(queryClient: QueryClient, id: string, post: ActionablePost): void {
  if (post.ref.id !== id) return;
  const affectedQueries = queryClient
    .getQueryCache()
    .findAll({ predicate: (query) => cacheValueContainsPost(query.state.data, id) });
  for (const query of affectedQueries) {
    queryClient.setQueryData(query.queryKey, (value: unknown) =>
      replacePosts(value, id, (candidate) => reconcileSuccessfulPost(candidate, post)),
    );
  }
}

function reconcileSuccessfulPost(
  optimistic: ActionablePost,
  response: ActionablePost,
): ActionablePost {
  const counts =
    response.counts === undefined
      ? optimistic.counts
      : optimistic.counts === undefined
        ? response.counts
        : { ...optimistic.counts, ...response.counts };
  const viewerState =
    response.viewerState === undefined
      ? optimistic.viewerState
      : optimistic.viewerState === undefined
        ? response.viewerState
        : { ...optimistic.viewerState, ...response.viewerState };
  return {
    ...response,
    ...(counts === undefined ? {} : { counts }),
    ...(viewerState === undefined ? {} : { viewerState }),
  };
}

function applyOptimisticAction<Post extends ActionablePost>(
  post: Post,
  input: PostActionInput,
): Post {
  const viewerState = post.viewerState ?? {};
  if (input.kind === "favourite") {
    return {
      ...post,
      counts: updateCount(post.counts, "favourites", viewerState.favourited, input.enabled),
      viewerState: { ...viewerState, favourited: input.enabled },
    };
  }
  if (input.kind === "reblog") {
    return {
      ...post,
      counts: updateCount(post.counts, "reblogs", viewerState.boosted, input.enabled),
      viewerState: { ...viewerState, boosted: input.enabled },
    };
  }
  if (input.kind === "bookmark") {
    return {
      ...post,
      viewerState: { ...viewerState, bookmarked: input.enabled },
    };
  }
  if (input.kind === "reaction") {
    return {
      ...post,
      viewerState: {
        ...viewerState,
        reactions: updateReactions(viewerState.reactions ?? [], input.reaction, input.enabled),
      },
    };
  }
  return post;
}

function updateCount(
  counts: PostCounts | undefined,
  key: keyof PostCounts,
  previous: boolean | undefined,
  enabled: boolean,
): PostCounts | undefined {
  if (counts === undefined || previous === enabled || counts[key] === undefined) return counts;
  return {
    ...counts,
    [key]: Math.max(0, (counts[key] ?? 0) + (enabled ? 1 : -1)),
  };
}

function updateReactions(
  reactions: readonly PostViewerReaction[],
  emoji: string,
  enabled: boolean,
): readonly PostViewerReaction[] {
  const index = reactions.findIndex((reaction) => reaction.emoji === emoji);
  if (index < 0) return enabled ? [...reactions, { emoji, me: true }] : reactions;
  const current = reactions[index];
  if (current === undefined || current.me === enabled) return reactions;
  const next = [...reactions];
  next[index] = {
    ...current,
    ...(current.count === undefined
      ? {}
      : { count: Math.max(0, current.count + (enabled ? 1 : -1)) }),
    me: enabled,
  };
  return next;
}

function collectPosts(value: unknown, id: string): readonly ActionablePost[] {
  const posts: ActionablePost[] = [];
  visitCacheValue(value, (candidate) => {
    if (postHasId(candidate, id)) posts.push(candidate);
  });
  return posts;
}

function cacheValueContainsPost(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((item) => cacheValueContainsPost(item, id));
  if (!isPlainObject(value)) return false;
  return (
    postHasId(value, id) || Object.values(value).some((child) => cacheValueContainsPost(child, id))
  );
}

function visitCacheValue(value: unknown, visit: (candidate: object) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitCacheValue(item, visit);
    return;
  }
  if (!isPlainObject(value)) return;
  visit(value);
  for (const child of Object.values(value)) visitCacheValue(child, visit);
}

function replacePosts(
  value: unknown,
  id: string,
  replace: (post: ActionablePost) => ActionablePost,
): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const replacement = replacePosts(item, id, replace);
      if (replacement !== item) changed = true;
      return replacement;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;
  if (postHasId(value, id)) return replace(value);

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const replacement = replacePosts(child, id, replace);
    next[key] = replacement;
    if (replacement !== child) changed = true;
  }
  return changed ? next : value;
}

function postHasId(value: object, id: string): value is ActionablePost {
  const ref = (value as { readonly ref?: unknown }).ref;
  return isPlainObject(ref) && ref["id"] === id && ref["type"] === "post";
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function queryKeyContainsId(queryKey: QueryKey, id: string): boolean {
  return queryKey.some((segment) => segment === id);
}

function errorMessage(error: Error, fallback: string): string {
  return error.message.trim() === "" ? fallback : error.message;
}
