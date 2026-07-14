import { useQuery } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useId, useState } from "react";

import { webKeys } from "../../api/client.js";
import { useI18n } from "../../i18n/i18n.js";
import {
  controlDecision,
  type CapabilityCollection,
  type CapabilityTranslator,
} from "./capability.js";

export interface ThreadPost {
  readonly ref: { readonly id: string };
}

export interface ThreadContext<Post extends ThreadPost = ThreadPost> {
  readonly ancestors: readonly Post[];
  readonly descendants: readonly Post[];
}

export interface ThreadRenderContext {
  readonly relation: "ancestor" | "current" | "descendant";
  readonly maxQuoteDepth: 1;
}

export interface ThreadViewLabels {
  readonly conversation: string;
  readonly showConversation: string;
  readonly loadingConversation: string;
  readonly retryConversation: string;
  readonly contextFailed: string;
}

export const postContextQueryKey = (id: string) => webKeys.postContext(id);

export interface ThreadViewProps<Post extends ThreadPost = ThreadPost> {
  readonly current: Post;
  readonly capabilities: CapabilityCollection;
  readonly loadContext: (id: string, signal?: AbortSignal) => Promise<ThreadContext<Post>>;
  readonly renderPost: (post: Post, context: ThreadRenderContext) => ReactNode;
  readonly labels?: Partial<ThreadViewLabels>;
  readonly translateCapability?: CapabilityTranslator;
}

export function ThreadView<Post extends ThreadPost>({
  capabilities,
  current,
  labels: labelOverrides,
  loadContext,
  renderPost,
  translateCapability,
}: ThreadViewProps<Post>): ReactElement {
  const { t } = useI18n();
  const labels: ThreadViewLabels = {
    conversation: t("thread.conversation"),
    showConversation: t("post.showContext"),
    loadingConversation: t("thread.loading"),
    retryConversation: t("thread.retry"),
    contextFailed: t("thread.failed"),
    ...labelOverrides,
  };
  const [requestedPostId, setRequestedPostId] = useState<string | null>(null);
  const contextId = useId();
  const reasonId = useId();
  const decision = controlDecision(capabilities, "context", translateCapability ?? t);
  const requested = requestedPostId === current.ref.id;
  const context = useQuery<ThreadContext<Post>, Error>({
    enabled: requested && decision.enabled,
    queryFn: ({ signal }) => loadContext(current.ref.id, signal),
    queryKey: postContextQueryKey(current.ref.id),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const ancestors = context.data?.ancestors ?? [];
  const descendants = context.data?.descendants ?? [];

  return (
    <section aria-label={labels.conversation} className="thread-view">
      <button
        aria-controls={contextId}
        aria-describedby={decision.enabled ? undefined : reasonId}
        aria-expanded={requested}
        disabled={!decision.enabled || requested}
        onClick={() => setRequestedPostId(current.ref.id)}
        type="button"
      >
        {labels.showConversation}
      </button>
      {decision.enabled ? null : <p id={reasonId}>{decision.reason}</p>}
      {context.isFetching ? <p role="status">{labels.loadingConversation}</p> : null}
      {context.error === null ? null : (
        <div>
          <p role="alert">{errorMessage(context.error, labels.contextFailed)}</p>
          <button
            disabled={context.isFetching}
            onClick={() => {
              void context.refetch();
            }}
            type="button"
          >
            {labels.retryConversation}
          </button>
        </div>
      )}
      <ol aria-label={labels.conversation} className="thread-view__list" id={contextId}>
        {ancestors.map((post) => (
          <li key={post.ref.id}>{renderPost(post, { maxQuoteDepth: 1, relation: "ancestor" })}</li>
        ))}
        <li key={current.ref.id}>
          {renderPost(current, { maxQuoteDepth: 1, relation: "current" })}
        </li>
        {descendants.map((post) => (
          <li key={post.ref.id}>
            {renderPost(post, { maxQuoteDepth: 1, relation: "descendant" })}
          </li>
        ))}
      </ol>
    </section>
  );
}

function errorMessage(error: Error, fallback: string): string {
  return error.message.trim() === "" ? fallback : error.message;
}
