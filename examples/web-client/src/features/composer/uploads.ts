import { type DraftAttachment } from "../../state/composer.js";

export const maxImageCount = 4;
export const maxImageBytes = 16 * 1024 * 1024;
export const acceptedImageTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ComposerValidationCode =
  | "TOO_MANY_IMAGES"
  | "IMAGE_TOO_LARGE"
  | "UNSUPPORTED_IMAGE_TYPE";

export class ComposerValidationError extends Error {
  public constructor(public readonly code: ComposerValidationCode) {
    super(code);
    this.name = "ComposerValidationError";
  }
}

export interface MediaUploadInput {
  readonly file: File;
  readonly description: string;
}

export interface UploadedMedia {
  readonly id: string;
  readonly remoteUrl?: string;
}

export interface MediaUploadPort {
  uploadMedia(input: MediaUploadInput, signal: AbortSignal): Promise<UploadedMedia>;
  deleteMedia?(mediaId: string): Promise<void>;
}

export interface UploadCoordinatorOptions {
  readonly canDeleteMedia?: boolean | (() => boolean);
}

type AttachmentListener = (attachment: DraftAttachment) => void;

const activeUploadCoordinators = new Set<UploadCoordinator>();
const logoutPreparationTimeoutMs = 2_000;

/** Registers a mounted composer so an account boundary can cancel its uploads. */
export function registerUploadCoordinator(coordinator: UploadCoordinator): () => void {
  activeUploadCoordinators.add(coordinator);
  return () => activeUploadCoordinators.delete(coordinator);
}

/** Starts every mounted coordinator cleanup and resolves after each one settles. */
export async function disposeActiveUploadCoordinators(): Promise<void> {
  const coordinators = [...activeUploadCoordinators];
  activeUploadCoordinators.clear();
  await Promise.allSettled(coordinators.map((coordinator) => coordinator.dispose()));
}

/** Prepares mounted coordinators for a logout attempt without disposing them. */
export async function prepareActiveUploadCoordinatorsForLogout(): Promise<void> {
  await Promise.allSettled(
    [...activeUploadCoordinators].map((coordinator) => coordinator.prepareForLogout()),
  );
}

export function validateImageFiles(currentCount: number, files: readonly File[]): void {
  if (!Number.isSafeInteger(currentCount) || currentCount < 0) {
    throw new TypeError("Current image count must be a non-negative safe integer.");
  }
  if (currentCount + files.length > maxImageCount) {
    throw new ComposerValidationError("TOO_MANY_IMAGES");
  }
  for (const file of files) {
    if (!acceptedImageTypes.has(file.type)) {
      throw new ComposerValidationError("UNSUPPORTED_IMAGE_TYPE");
    }
    if (file.size > maxImageBytes) {
      throw new ComposerValidationError("IMAGE_TOO_LARGE");
    }
  }
}

export function createDraftAttachment(file: File): DraftAttachment {
  return {
    localId: globalThis.crypto.randomUUID(),
    file,
    previewUrl: URL.createObjectURL(file),
    altText: "",
    status: "draft",
  };
}

export function createDraftAttachments(
  currentCount: number,
  files: readonly File[],
): readonly DraftAttachment[] {
  validateImageFiles(currentCount, files);
  const attachments: DraftAttachment[] = [];
  try {
    for (const file of files) attachments.push(createDraftAttachment(file));
    return attachments;
  } catch (error) {
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    throw error;
  }
}

export class UploadCoordinator {
  readonly #port: MediaUploadPort;
  readonly #options: UploadCoordinatorOptions;
  readonly #attachments = new Map<string, DraftAttachment>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #deletions = new Map<string, Promise<void>>();
  readonly #inFlight = new Map<string, Promise<DraftAttachment>>();
  readonly #listeners = new Set<AttachmentListener>();
  readonly #held = new Set<string>();
  readonly #removed = new Set<string>();
  readonly #revokedPreviews = new Map<string, string>();
  #disposed = false;

  public constructor(port: MediaUploadPort, options: UploadCoordinatorOptions = {}) {
    this.#port = port;
    this.#options = options;
  }

  public subscribe(listener: AttachmentListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public track(attachment: DraftAttachment): void {
    if (this.#disposed) return;
    this.#removed.delete(attachment.localId);
    this.#attachments.set(attachment.localId, attachment);
  }

  public get(localId: string): DraftAttachment | undefined {
    return this.#attachments.get(localId);
  }

  public confirm(input: string | DraftAttachment): Promise<DraftAttachment> {
    if (this.#disposed) return Promise.reject(abortError());
    const attachment = typeof input === "string" ? this.#attachments.get(input) : input;
    if (attachment === undefined) {
      return Promise.reject(new Error("Draft attachment is not available."));
    }
    const pending = this.#inFlight.get(attachment.localId);
    if (pending !== undefined) return pending;
    const current = this.#attachments.get(attachment.localId) ?? attachment;
    if (current.status === "uploaded") return Promise.resolve(current);

    const withPreview = this.#restorePreview(current);
    const uploading: DraftAttachment = {
      localId: withPreview.localId,
      file: withPreview.file,
      previewUrl: withPreview.previewUrl,
      altText: withPreview.altText,
      status: "uploading",
    };
    this.#set(uploading);
    const controller = new AbortController();
    this.#controllers.set(uploading.localId, controller);
    const upload = Promise.resolve().then(() => this.#performUpload(uploading, controller));
    this.#inFlight.set(uploading.localId, upload);
    return upload;
  }

  public retry(localId: string): Promise<DraftAttachment> {
    const attachment = this.#attachments.get(localId);
    if (attachment === undefined)
      return Promise.reject(new Error("Draft attachment is not available."));
    return this.confirm(attachment);
  }

  public abort(localId: string): DraftAttachment | undefined {
    const attachment = this.#attachments.get(localId);
    if (attachment === undefined) return undefined;
    this.#controllers.get(localId)?.abort(abortError());
    this.#revokePreview(attachment);
    const failed: DraftAttachment = {
      localId: attachment.localId,
      file: attachment.file,
      previewUrl: attachment.previewUrl,
      altText: attachment.altText,
      status: "failed",
      error: "Upload cancelled.",
    };
    this.#set(failed);
    return failed;
  }

  public async remove(input: string | DraftAttachment): Promise<void> {
    const localId = typeof input === "string" ? input : input.localId;
    const attachment =
      this.#attachments.get(localId) ?? (typeof input === "string" ? undefined : input);
    if (attachment === undefined) return;
    this.#removed.add(attachment.localId);
    this.#controllers.get(attachment.localId)?.abort(abortError());
    this.#revokePreview(attachment);

    const held = this.#held.has(attachment.localId);
    if (attachment.status === "uploaded" && !held) {
      try {
        await this.#deleteMedia(attachment.mediaId);
      } catch (error) {
        this.#removed.delete(attachment.localId);
        this.#set({ ...attachment, error: errorMessage(error) });
        throw error;
      }
    }
    this.#held.delete(attachment.localId);
    this.#attachments.delete(attachment.localId);
    this.#revokedPreviews.delete(attachment.localId);
    if (!this.#inFlight.has(attachment.localId)) this.#removed.delete(attachment.localId);
  }

  public hold(attachments: readonly DraftAttachment[]): void {
    for (const attachment of attachments) {
      this.#attachments.set(attachment.localId, attachment);
      this.#held.add(attachment.localId);
    }
  }

  public async release(attachments: readonly DraftAttachment[]): Promise<void> {
    const cleanup: Promise<unknown>[] = [];
    for (const attachment of attachments) {
      this.#held.delete(attachment.localId);
      if (!this.#disposed) continue;
      const current = this.#attachments.get(attachment.localId) ?? attachment;
      if (current.status === "uploaded") cleanup.push(this.#deleteMedia(current.mediaId));
      this.#attachments.delete(attachment.localId);
      this.#revokedPreviews.delete(attachment.localId);
    }
    await Promise.allSettled(cleanup);
  }

  public commit(attachments: readonly DraftAttachment[]): void {
    for (const attachment of attachments) {
      this.#revokePreview(attachment);
      this.#held.delete(attachment.localId);
      this.#attachments.delete(attachment.localId);
      this.#revokedPreviews.delete(attachment.localId);
    }
  }

  /** Cancels transferable work before logout while keeping this coordinator reusable. */
  public async prepareForLogout(): Promise<void> {
    if (this.#disposed) return;
    const cleanup: Promise<unknown>[] = [];
    for (const controller of this.#controllers.values()) controller.abort(abortError());
    for (const attachment of this.#attachments.values()) {
      if (this.#held.has(attachment.localId)) continue;
      if (attachment.status === "uploaded") cleanup.push(this.#deleteMedia(attachment.mediaId));
    }
    cleanup.push(...this.#inFlight.values());
    await settleForLogout(cleanup);
    for (const attachment of this.#attachments.values()) {
      if (this.#held.has(attachment.localId)) continue;
      this.#discardPreparedAttachment(attachment);
    }
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const cleanup: Promise<unknown>[] = [];
    for (const controller of this.#controllers.values()) controller.abort(abortError());
    for (const attachment of this.#attachments.values()) {
      if (this.#held.has(attachment.localId)) continue;
      this.#revokePreview(attachment);
      if (attachment.status === "uploaded") cleanup.push(this.#deleteMedia(attachment.mediaId));
    }
    cleanup.push(...this.#inFlight.values());
    await Promise.allSettled(cleanup);
    for (const localId of this.#attachments.keys()) {
      if (this.#held.has(localId)) continue;
      this.#attachments.delete(localId);
      this.#revokedPreviews.delete(localId);
    }
    this.#removed.clear();
    this.#listeners.clear();
  }

  async #performUpload(
    attachment: DraftAttachment,
    controller: AbortController,
  ): Promise<DraftAttachment> {
    try {
      controller.signal.throwIfAborted();
      const media = await this.#port.uploadMedia(
        { file: attachment.file, description: attachment.altText },
        controller.signal,
      );
      if (controller.signal.aborted || this.#disposed || this.#removed.has(attachment.localId)) {
        if (!this.#held.has(attachment.localId)) await this.#deleteLateMedia(media.id);
        throw abortError();
      }
      const uploaded: DraftAttachment = {
        localId: attachment.localId,
        file: attachment.file,
        previewUrl: attachment.previewUrl,
        altText: attachment.altText,
        status: "uploaded",
        mediaId: media.id,
        ...(media.remoteUrl === undefined ? {} : { remoteUrl: media.remoteUrl }),
      };
      this.#revokePreview(attachment);
      this.#set(uploaded);
      return uploaded;
    } catch (error) {
      if (!this.#disposed && !this.#removed.has(attachment.localId)) {
        const existing = this.#attachments.get(attachment.localId);
        const source = existing ?? attachment;
        const failed: DraftAttachment = {
          localId: source.localId,
          file: source.file,
          previewUrl: source.previewUrl,
          altText: source.altText,
          status: "failed",
          error: isAbortError(error) ? "Upload cancelled." : errorMessage(error),
        };
        this.#revokePreview(failed);
        this.#set(failed);
      }
      throw error;
    } finally {
      if (this.#controllers.get(attachment.localId) === controller) {
        this.#controllers.delete(attachment.localId);
        this.#inFlight.delete(attachment.localId);
        if (!this.#attachments.has(attachment.localId)) {
          this.#removed.delete(attachment.localId);
          this.#revokedPreviews.delete(attachment.localId);
        }
      }
    }
  }

  #restorePreview<T extends DraftAttachment>(attachment: T): T {
    if (this.#revokedPreviews.get(attachment.localId) !== attachment.previewUrl) {
      return attachment;
    }
    const previewUrl = URL.createObjectURL(attachment.file);
    this.#revokedPreviews.delete(attachment.localId);
    return { ...attachment, previewUrl };
  }

  #set(attachment: DraftAttachment): void {
    this.#attachments.set(attachment.localId, attachment);
    for (const listener of this.#listeners) listener(attachment);
  }

  #revokePreview(attachment: DraftAttachment): void {
    if (
      attachment.previewUrl === "" ||
      this.#revokedPreviews.get(attachment.localId) === attachment.previewUrl
    ) {
      return;
    }
    URL.revokeObjectURL(attachment.previewUrl);
    this.#revokedPreviews.set(attachment.localId, attachment.previewUrl);
  }

  #discardPreparedAttachment(attachment: DraftAttachment): void {
    this.#removed.add(attachment.localId);
    try {
      if (this.#listeners.size === 0) {
        this.#revokePreview(attachment);
      } else {
        const source = this.#restorePreview(attachment);
        const draft: DraftAttachment = {
          localId: source.localId,
          file: source.file,
          previewUrl: source.previewUrl,
          altText: source.altText,
          status: "draft",
        };
        for (const listener of this.#listeners) listener(draft);
      }
    } finally {
      this.#attachments.delete(attachment.localId);
      this.#revokedPreviews.delete(attachment.localId);
      if (!this.#inFlight.has(attachment.localId)) this.#removed.delete(attachment.localId);
    }
  }

  #canDeleteMedia(): boolean {
    const configured = this.#options.canDeleteMedia;
    return typeof configured === "function" ? configured() : configured === true;
  }

  async #deleteLateMedia(mediaId: string): Promise<void> {
    try {
      await this.#deleteMedia(mediaId);
    } catch {
      // Cleanup is best-effort after the owning draft has already gone away.
    }
  }

  #deleteMedia(mediaId: string): Promise<void> {
    if (!this.#canDeleteMedia() || this.#port.deleteMedia === undefined) return Promise.resolve();
    const existing = this.#deletions.get(mediaId);
    if (existing !== undefined) return existing;
    const deletion = Promise.resolve().then(() => this.#port.deleteMedia?.(mediaId));
    const tracked = deletion.then(() => undefined);
    this.#deletions.set(mediaId, tracked);
    void tracked.then(
      () => {
        if (this.#deletions.get(mediaId) === tracked) this.#deletions.delete(mediaId);
      },
      () => {
        if (this.#deletions.get(mediaId) === tracked) this.#deletions.delete(mediaId);
      },
    );
    return tracked;
  }
}

export async function uploadDraftAttachments(
  attachments: readonly DraftAttachment[],
  coordinator: UploadCoordinator,
): Promise<readonly DraftAttachment[]> {
  for (const attachment of attachments) coordinator.track(attachment);
  return Promise.all(
    attachments.map((attachment) => {
      if (attachment.status === "uploaded") return Promise.resolve(attachment);
      if (attachment.status === "failed") {
        return Promise.reject(new Error(attachment.error ?? "An image upload failed."));
      }
      return coordinator.confirm(attachment);
    }),
  );
}

export function requiredUploadedId(attachment: DraftAttachment): string {
  if (attachment.status !== "uploaded") {
    throw new Error("Attachment upload did not produce a media ID.");
  }
  return attachment.mediaId;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

async function settleForLogout(cleanup: readonly Promise<unknown>[]): Promise<void> {
  if (cleanup.length === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(cleanup),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, logoutPreparationTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Upload failed.";
}
