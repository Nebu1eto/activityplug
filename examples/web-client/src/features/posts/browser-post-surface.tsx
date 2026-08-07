import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { type ReactElement } from "react";

import { type ProductApi, webKeys } from "../../api/client.js";
import { type BrowserCapabilitySet } from "../../api/contracts.js";
import { useI18n } from "../../i18n/i18n.js";
import { navigateProductHref, productRouteHref } from "../../routing/location.js";
import { composerAtom } from "../../state/composer.js";
import { PostActions, type ActionablePost } from "./post-actions.js";
import { PostCard, type PostCardViewModel } from "./post-card.js";

export interface BrowserPostSurfaceProps {
  readonly api: ProductApi;
  readonly capabilities: BrowserCapabilitySet;
  readonly post: BrowserSurfacePost;
  readonly onTarget?: () => void;
}

/** The public post fields every BFF list and detail response exposes. */
export interface BrowserSurfacePost {
  readonly ref: { readonly id: string; readonly type?: string; readonly url?: string };
  readonly author: {
    readonly ref: { readonly id: string };
    readonly displayName: string;
    readonly avatarUrl?: string;
  };
  readonly contentHtml: string;
  readonly createdAt: string;
  readonly sensitive: boolean;
  readonly summary?: string;
  readonly media: readonly {
    readonly ref: { readonly id: string };
    readonly type: "image" | "video" | "audio" | "gifv" | "unknown";
    readonly url: string;
    readonly previewUrl?: string;
    readonly description?: string;
  }[];
  readonly replyTo?: { readonly id: string; readonly url?: string };
  readonly quoteOf?: { readonly id: string; readonly url?: string };
  readonly boostOf?: { readonly id: string; readonly url?: string };
  readonly counts?: {
    readonly replies?: number;
    readonly reblogs?: number;
    readonly favourites?: number;
  };
  readonly viewerState?: {
    readonly favourited?: boolean;
    readonly boosted?: boolean;
    readonly bookmarked?: boolean;
    readonly reactions?: readonly {
      readonly emoji: string;
      readonly count?: number;
      readonly me: boolean;
    }[];
  };
}

/** The product's one post presentation, shared by every post-bearing route. */
export function BrowserPostSurface({
  api,
  capabilities,
  post,
  onTarget,
}: BrowserPostSurfaceProps): ReactElement {
  const setDraft = useSetAtom(composerAtom);
  const { t } = useI18n();
  const actionablePost = requireActionablePost(post);
  const boostedPostId =
    post.boostOf !== undefined && post.contentHtml.trim() === "" ? post.boostOf.id : undefined;
  const boostedPostQuery = useQuery({
    queryKey: webKeys.post(boostedPostId ?? post.ref.id),
    queryFn: ({ signal }) => {
      if (boostedPostId === undefined) {
        throw new TypeError("Boosted post identifier is unavailable.");
      }
      return api.post(boostedPostId, signal);
    },
    enabled: boostedPostId !== undefined,
    retry: false,
  });
  const contentPost =
    boostedPostId !== undefined && boostedPostQuery.isSuccess ? boostedPostQuery.data.post : post;
  const target = (kind: "reply" | "quote"): void => {
    setDraft((draft) => ({
      ...draft,
      ...(kind === "reply"
        ? { replyToId: post.ref.id, quoteOfId: undefined }
        : { replyToId: undefined, quoteOfId: post.ref.id }),
    }));
    navigateProductHref("/");
    onTarget?.();
  };

  return (
    <div className="browser-post-surface">
      <PostCard
        post={toPostCard(post, contentPost, t("post.reply"), t("post.quote"), t("post.boost"))}
      />
      <PostActions
        actOnPost={async (id, input) => {
          const response = await api.actOnPost(id, input);
          return { post: requireActionablePost(response.post) };
        }}
        capabilities={capabilities}
        onQuote={() => target("quote")}
        onReply={() => target("reply")}
        post={actionablePost}
      />
    </div>
  );
}

function requireActionablePost<Post extends BrowserSurfacePost>(post: Post): Post & ActionablePost {
  if (post.ref.type !== "post") {
    throw new TypeError("Browser post reference type must be post.");
  }
  return post as Post & ActionablePost;
}

function toPostCard(
  post: BrowserSurfacePost,
  contentPost: BrowserSurfacePost,
  reply: string,
  quote: string,
  boost: string,
): PostCardViewModel {
  return {
    id: post.ref.id,
    author: {
      displayName: post.author.displayName,
      ...(post.author.avatarUrl === undefined ? {} : { avatarUrl: post.author.avatarUrl }),
      profileUrl: productRouteHref({ name: "profile", id: post.author.ref.id }),
    },
    contentHtml: contentPost.contentHtml,
    createdAt: post.createdAt,
    ...(contentPost.summary === undefined ? {} : { summary: contentPost.summary }),
    sensitive: contentPost.sensitive,
    media: contentPost.media.map((media) => ({
      id: media.ref.id,
      kind: media.type === "gifv" ? "video" : media.type,
      url: media.url,
      ...(media.previewUrl === undefined ? {} : { previewUrl: media.previewUrl }),
      ...(media.description === undefined ? {} : { description: media.description }),
    })),
    ...(post.replyTo === undefined ? {} : { replyTo: relation(post.replyTo.id, reply) }),
    ...(post.quoteOf === undefined ? {} : { quoteOf: relation(post.quoteOf.id, quote) }),
    ...(post.boostOf === undefined ? {} : { boostOf: relation(post.boostOf.id, boost) }),
    counts: {
      replies: post.counts?.replies ?? 0,
      boosts: post.counts?.reblogs ?? 0,
      favourites: post.counts?.favourites ?? 0,
    },
  };
}

function relation(id: string, label: string) {
  return { id, label, href: productRouteHref({ name: "post", id }) };
}
