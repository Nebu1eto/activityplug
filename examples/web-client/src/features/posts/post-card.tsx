import { useId, useState, type ReactElement } from "react";

import { useI18n } from "../../i18n/i18n.js";
import { ProductLink, productRouteHref } from "../../routing/location.js";
import { SafeHtml } from "./safe-html.js";

const externalLinkRel = "nofollow noopener noreferrer";

export interface PostCardAuthor {
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly profileUrl?: string;
}

export interface PostCardMedia {
  readonly id: string;
  readonly kind: "image" | "video" | "audio" | "unknown";
  readonly url: string;
  readonly previewUrl?: string;
  readonly description?: string;
}

export interface PostCardRelation {
  readonly id: string;
  readonly label: string;
  readonly href?: string;
}

export interface PostCardCounts {
  readonly replies: number;
  readonly boosts: number;
  readonly favourites: number;
}

export interface PostCardViewModel {
  readonly id: string;
  readonly author: PostCardAuthor;
  readonly contentHtml: string;
  readonly createdAt: string;
  readonly summary?: string;
  readonly sensitive: boolean;
  readonly media: readonly PostCardMedia[];
  readonly replyTo?: PostCardRelation;
  readonly quoteOf?: PostCardRelation;
  readonly boostOf?: PostCardRelation;
  readonly counts: PostCardCounts;
}

export interface PostCardMessages {
  readonly showContent: string;
  readonly hideContent: string;
  readonly sensitiveContent: string;
  readonly mediaFallback: string;
  readonly videoAttachment: string;
  readonly audioAttachment: string;
  readonly attachment: string;
  readonly avatar: (name: string) => string;
  readonly author: (name: string) => string;
  readonly permalink: string;
  readonly relations: string;
  readonly counts: (counts: PostCardCounts) => string;
}

export interface PostCardProps {
  readonly post: PostCardViewModel;
  readonly formatTimestamp?: (createdAt: string) => string;
  readonly postHref?: (id: string) => string;
  readonly messages?: Partial<PostCardMessages>;
}

export function PostCard({
  post,
  formatTimestamp,
  postHref = defaultPostHref,
  messages: messageOverrides,
}: PostCardProps): ReactElement {
  const { locale, t } = useI18n();
  const messages: PostCardMessages = {
    showContent: t("post.showContent"),
    hideContent: t("post.hideContent"),
    sensitiveContent: t("post.sensitiveContent"),
    mediaFallback: t("post.mediaFallback"),
    videoAttachment: t("post.video"),
    audioAttachment: t("post.audio"),
    attachment: t("post.attachment"),
    avatar: (name: string) => t("post.avatar", { name }),
    author: (name: string) => t("post.author", { name }),
    permalink: t("post.permalink"),
    relations: t("post.relations"),
    counts: ({ replies, boosts, favourites }: PostCardCounts) =>
      t("post.counts", { replies, boosts, favourites }),
    ...messageOverrides,
  };
  const headingId = useId();
  const hasDisclosure = post.sensitive || (post.summary?.trim().length ?? 0) > 0;
  const [isExpanded, setIsExpanded] = useState(!hasDisclosure);
  const summary = post.summary?.trim() || (post.sensitive ? messages.sensitiveContent : "");
  const permalink = postHref(post.id);

  return (
    <article aria-labelledby={headingId} className="post-card">
      <header className="post-card__header">
        {renderAvatar(post.author, messages)}
        <div className="post-card__byline">
          <h2 id={headingId}>{renderAuthorName(post.author, messages)}</h2>
          <time dateTime={post.createdAt}>
            {formatTimestamp === undefined
              ? formatRelativeTimestamp(post.createdAt, locale)
              : formatTimestamp(post.createdAt)}
          </time>
        </div>
        <Permalink href={permalink} label={messages.permalink} />
      </header>
      <Relations messages={messages} post={post} postHref={postHref} />
      {hasDisclosure ? (
        <button
          aria-expanded={isExpanded}
          type="button"
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? messages.hideContent : messages.showContent}
        </button>
      ) : null}
      {summary ? <p className="post-card__summary">{summary}</p> : null}
      {isExpanded ? (
        <>
          <SafeHtml html={post.contentHtml} />
          <MediaList media={post.media} messages={messages} />
        </>
      ) : null}
      <p aria-label={messages.counts(post.counts)} className="post-card__counts">
        {messages.counts(post.counts)}
      </p>
    </article>
  );
}

function Permalink({
  href,
  label,
}: {
  readonly href: string;
  readonly label: string;
}): ReactElement | null {
  if (isInternalNavigationHref(href)) {
    return (
      <ProductLink aria-label={label} href={href}>
        {label}
      </ProductLink>
    );
  }
  if (isSafeResourceUrl(href)) {
    return (
      <a aria-label={label} href={href} rel={externalLinkRel} target="_blank">
        {label}
      </a>
    );
  }
  return null;
}

function renderAvatar(author: PostCardAuthor, messages: PostCardMessages): ReactElement {
  if (isSafeResourceUrl(author.avatarUrl)) {
    return (
      <img
        alt={messages.avatar(author.displayName)}
        className="post-card__avatar"
        src={author.avatarUrl}
      />
    );
  }
  return (
    <span aria-hidden="true" className="post-card__avatar post-card__avatar--fallback">
      {initials(author.displayName)}
    </span>
  );
}

function renderAuthorName(
  author: PostCardAuthor,
  messages: PostCardMessages,
): ReactElement | string {
  if (author.profileUrl === undefined || !isSafeNavigationHref(author.profileUrl)) {
    return author.displayName;
  }
  if (isInternalNavigationHref(author.profileUrl)) {
    return (
      <ProductLink aria-label={messages.author(author.displayName)} href={author.profileUrl}>
        {author.displayName}
      </ProductLink>
    );
  }
  return (
    <a aria-label={messages.author(author.displayName)} href={author.profileUrl}>
      {author.displayName}
    </a>
  );
}

function Relations({
  post,
  postHref,
  messages,
}: {
  readonly post: PostCardViewModel;
  readonly postHref: (id: string) => string;
  readonly messages: PostCardMessages;
}): ReactElement | null {
  const relations = [post.replyTo, post.quoteOf, post.boostOf].filter(
    (relation): relation is PostCardRelation => relation !== undefined,
  );
  if (relations.length === 0) return null;

  return (
    <nav aria-label={messages.relations} className="post-card__relations">
      {relations.map((relation) => {
        const href = relation.href ?? postHref(relation.id);
        return isInternalNavigationHref(href) ? (
          <ProductLink href={href} key={relation.id}>
            {relation.label}
          </ProductLink>
        ) : isSafeResourceUrl(href) ? (
          <a href={href} key={relation.id} rel={externalLinkRel} target="_blank">
            {relation.label}
          </a>
        ) : (
          <span key={relation.id}>{relation.label}</span>
        );
      })}
    </nav>
  );
}

function MediaList({
  media,
  messages,
}: {
  readonly media: readonly PostCardMedia[];
  readonly messages: PostCardMessages;
}): ReactElement | null {
  if (media.length === 0) return null;

  return (
    <ul aria-label={messages.mediaFallback} className="post-card__media">
      {media.map((attachment) => (
        <li className="post-card__media-item" key={attachment.id}>
          {renderMedia(attachment, messages)}
        </li>
      ))}
    </ul>
  );
}

function renderMedia(attachment: PostCardMedia, messages: PostCardMessages): ReactElement | null {
  if (!isSafeResourceUrl(attachment.url)) return null;
  switch (attachment.kind) {
    case "image":
      return (
        <img
          alt={attachment.description || messages.mediaFallback}
          className="post-card__media-content"
          src={attachment.url}
        />
      );
    case "video":
      return (
        <video
          aria-label={messages.videoAttachment}
          className="post-card__media-content"
          controls
          poster={isSafeResourceUrl(attachment.previewUrl) ? attachment.previewUrl : undefined}
          preload="metadata"
          src={attachment.url}
        />
      );
    case "audio":
      return (
        <audio
          aria-label={messages.audioAttachment}
          className="post-card__media-content"
          controls
          preload="metadata"
          src={attachment.url}
        />
      );
    case "unknown":
      return (
        <a href={attachment.url} rel={externalLinkRel} target="_blank">
          {attachment.description || messages.attachment}
        </a>
      );
    default:
      return null;
  }
}

function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toLocaleUpperCase())
    .join("");
}

function defaultPostHref(id: string): string {
  return productRouteHref({ name: "post", id });
}

function formatRelativeTimestamp(createdAt: string, locale: string): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return createdAt;
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function isSafeResourceUrl(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isSafeNavigationHref(value: string): boolean {
  return isInternalNavigationHref(value) || isSafeResourceUrl(value);
}

function isInternalNavigationHref(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  if (typeof window === "undefined") return false;
  try {
    return new URL(value, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
