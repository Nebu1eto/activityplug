import DOMPurify from "dompurify";
import { type ReactElement } from "react";

const allowedTags = [
  "a",
  "abbr",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "u",
  "ul",
] as const;

const allowedAttributes = ["class", "href", "lang", "rel", "target", "title"] as const;
const externalLinkRel = "nofollow noopener noreferrer";

export interface SafeHtmlProps {
  readonly html: string;
}

export function SafeHtml({ html }: SafeHtmlProps): ReactElement {
  return (
    <div className="safe-html" dangerouslySetInnerHTML={{ __html: sanitizeRemoteHtml(html) }} />
  );
}

export function sanitizeRemoteHtml(html: string): string {
  if (typeof html !== "string" || typeof DOMParser === "undefined") return "";

  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...allowedTags],
    ALLOWED_ATTR: [...allowedAttributes],
    ALLOW_DATA_ATTR: false,
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  for (const anchor of document.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (href === null || !isSafeLink(href)) {
      anchor.removeAttribute("href");
      anchor.removeAttribute("rel");
      anchor.removeAttribute("target");
      continue;
    }
    anchor.setAttribute("rel", externalLinkRel);
    anchor.setAttribute("target", "_blank");
  }
  return document.body.innerHTML;
}

function isSafeLink(value: string): boolean {
  if (value.startsWith("#")) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}
