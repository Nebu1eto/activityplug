import { atom, type createStore } from "jotai";

type Store = ReturnType<typeof createStore>;

export type ComposerVisibility = "public" | "unlisted" | "followers" | "direct" | "local";

export type UploadStatus = "draft" | "uploading" | "uploaded" | "failed";

interface DraftAttachmentBase {
  readonly localId: string;
  readonly file: File;
  readonly previewUrl: string;
  readonly altText: string;
}

export type DraftAttachment =
  | (DraftAttachmentBase & {
      readonly status: "draft" | "uploading";
      readonly mediaId?: undefined;
      readonly remoteUrl?: undefined;
      readonly error?: undefined;
    })
  | (DraftAttachmentBase & {
      readonly status: "failed";
      readonly error: string;
      readonly mediaId?: undefined;
      readonly remoteUrl?: undefined;
    })
  | (DraftAttachmentBase & {
      readonly status: "uploaded";
      readonly mediaId: string;
      readonly remoteUrl?: string;
      readonly error?: string;
    });

export interface ComposerDraft {
  readonly content: string;
  readonly visibility: ComposerVisibility;
  readonly summary: string;
  readonly sensitive: boolean;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly attachments: readonly DraftAttachment[];
}

export function createEmptyComposerDraft(
  initial: Pick<ComposerDraft, "replyToId" | "quoteOfId"> = {},
): ComposerDraft {
  return {
    content: "",
    visibility: "public",
    summary: "",
    sensitive: false,
    ...initial,
    attachments: [],
  };
}

export const composerAtom = atom<ComposerDraft>(createEmptyComposerDraft());

/**
 * Discard the browser-only draft before an account boundary changes. Preview
 * URLs are capabilities for local blobs, so they must not survive a logout or
 * an expired browser session.
 */
export function resetComposerState(store: Store): void {
  const draft = store.get(composerAtom);
  for (const attachment of draft.attachments) URL.revokeObjectURL(attachment.previewUrl);
  store.set(composerAtom, createEmptyComposerDraft());
}
