import { useMutation } from "@tanstack/react-query";
import { useAtom } from "jotai";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { WebApiError } from "../../api/http.js";
import { useI18n } from "../../i18n/i18n.js";
import {
  composerAtom,
  createEmptyComposerDraft,
  type ComposerDraft,
  type ComposerVisibility,
  type DraftAttachment,
} from "../../state/composer.js";
import {
  acceptedImageTypes,
  ComposerValidationError,
  createDraftAttachments,
  requiredUploadedId,
  registerUploadCoordinator,
  UploadCoordinator,
  uploadDraftAttachments,
  type MediaUploadPort,
} from "./uploads.js";

export interface CreatePostInput {
  readonly content: string;
  readonly visibility: ComposerVisibility;
  readonly summary?: string;
  readonly sensitive: boolean;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds: readonly string[];
}

export interface CreatePostPort {
  createPost(input: CreatePostInput): Promise<unknown>;
}

export interface ComposerControlDecision {
  readonly enabled: boolean;
  readonly reason?: string;
}

export type ComposerControl =
  | "contentWarning"
  | "content"
  | "create"
  | "deleteUpload"
  | "quote"
  | "reply"
  | "sensitive"
  | "upload"
  | "visibility";

export type ComposerControlDecisions = Partial<
  Readonly<Record<ComposerControl, ComposerControlDecision>>
>;

export interface ComposerProps {
  readonly media: MediaUploadPort;
  readonly posts: CreatePostPort;
  readonly controls?: ComposerControlDecisions;
  readonly supportedVisibilities?: readonly ComposerVisibility[];
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly onPostCreated?: (post: unknown) => Promise<void> | void;
}

interface SubmissionResult {
  readonly post: unknown;
  readonly attachments: readonly DraftAttachment[];
  readonly snapshot: ComposerDraft;
}

class PostOutcomeUnknownError extends Error {
  public constructor(cause: unknown) {
    super("Post creation outcome is unknown.", cause instanceof Error ? { cause } : undefined);
    this.name = "PostOutcomeUnknownError";
  }
}

const definitePostFailureCodes = new Set<WebApiError["code"]>([
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UNSUPPORTED",
  "MISSING_CSRF",
  "INVALID_PATH",
]);

const visibilityOptions = [
  "public",
  "unlisted",
  "followers",
  "direct",
  "local",
] as const satisfies readonly ComposerVisibility[];

export function Composer({
  media,
  posts,
  controls,
  supportedVisibilities,
  replyToId,
  quoteOfId,
  onPostCreated,
}: ComposerProps): ReactElement {
  const { t } = useI18n();
  const [draft, setDraft] = useAtom(composerAtom);
  const [error, setError] = useState<string>();
  const controlId = useId();
  const controlsRef = useRef(controls);
  const currentCoordinatorRef = useRef<UploadCoordinator | undefined>(undefined);
  const coordinatorGeneration = useRef(0);
  const targetInitialization = useRef(false);
  const submitInFlight = useRef<Promise<SubmissionResult> | undefined>(undefined);
  controlsRef.current = controls;
  const allowedVisibilities = useMemo(
    () => visibleVisibilities(supportedVisibilities),
    [supportedVisibilities],
  );
  const contentDecision = decisionFor(controls, "content");
  const contentWarningDecision = decisionFor(controls, "contentWarning");
  const sensitiveDecision = decisionFor(controls, "sensitive");

  useEffect(() => {
    setDraft((current) =>
      normalizeDraftForControls(current, {
        allowedVisibilities,
        content: contentDecision.enabled,
        contentWarning: contentWarningDecision.enabled,
        sensitive: sensitiveDecision.enabled,
      }),
    );
  }, [
    allowedVisibilities,
    contentDecision.enabled,
    contentWarningDecision.enabled,
    sensitiveDecision.enabled,
    setDraft,
  ]);

  const coordinator = useMemo(
    () =>
      new UploadCoordinator(media, {
        canDeleteMedia: () => decisionFor(controlsRef.current, "deleteUpload").enabled,
      }),
    [media],
  );
  currentCoordinatorRef.current = coordinator;

  useEffect(() => {
    if (targetInitialization.current) return;
    targetInitialization.current = true;
    if (replyToId === undefined && quoteOfId === undefined) return;
    setDraft((current) => ({
      ...current,
      ...(current.replyToId !== undefined || replyToId === undefined ? {} : { replyToId }),
      ...(current.quoteOfId !== undefined || quoteOfId === undefined ? {} : { quoteOfId }),
    }));
  }, [quoteOfId, replyToId, setDraft]);

  useEffect(() => {
    const generation = coordinatorGeneration.current + 1;
    coordinatorGeneration.current = generation;
    const unregister = registerUploadCoordinator(coordinator);
    const unsubscribe = coordinator.subscribe((attachment) => {
      setDraft((current) => replaceAttachment(current, attachment));
    });
    return () => {
      unregister();
      unsubscribe();
      queueMicrotask(() => {
        const replayed =
          currentCoordinatorRef.current === coordinator &&
          coordinatorGeneration.current !== generation;
        if (!replayed) {
          setDraft((current) => {
            const attachments = current.attachments.filter(
              ({ localId }) => coordinator.get(localId) === undefined,
            );
            return attachments.length === current.attachments.length
              ? current
              : { ...current, attachments };
          });
          void coordinator.dispose();
        }
      });
    };
  }, [coordinator, setDraft]);

  useEffect(() => {
    for (const attachment of draft.attachments) coordinator.track(attachment);
  }, [coordinator, draft.attachments]);

  const mutation = useMutation({
    retry: false,
    mutationFn: async (snapshot: ComposerDraft): Promise<SubmissionResult> => {
      const attachments = await uploadDraftAttachments(snapshot.attachments, coordinator);
      coordinator.hold(attachments);
      try {
        const post = await posts.createPost({
          content: snapshot.content,
          visibility: snapshot.visibility,
          ...(snapshot.summary.trim() === "" ? {} : { summary: snapshot.summary }),
          sensitive: snapshot.sensitive,
          ...(snapshot.replyToId === undefined ? {} : { replyToId: snapshot.replyToId }),
          ...(snapshot.quoteOfId === undefined ? {} : { quoteOfId: snapshot.quoteOfId }),
          mediaIds: attachments.map(requiredUploadedId),
        });
        return { post, attachments, snapshot };
      } catch (cause) {
        if (isPostOutcomeUnknown(cause)) throw new PostOutcomeUnknownError(cause);
        await coordinator.release(attachments);
        throw cause;
      }
    },
  });

  const createDecision = decisionFor(controls, "create");
  const hasUploading = draft.attachments.some(({ status }) => status === "uploading");
  const hasFailed = draft.attachments.some(({ status }) => status === "failed");
  const isEmpty = draft.content.trim() === "" && draft.attachments.length === 0;
  const submitDisabled =
    mutation.isPending ||
    hasUploading ||
    hasFailed ||
    isEmpty ||
    !createDecision.enabled ||
    !contentDecision.enabled;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitDisabled || submitInFlight.current !== undefined) return;
    setError(undefined);
    const pending = mutation.mutateAsync(draft);
    submitInFlight.current = pending;
    try {
      const result = await pending;
      coordinator.commit(result.attachments);
      setDraft((current) => clearSubmittedDraft(current, result.snapshot));
      setError(undefined);
      if (onPostCreated !== undefined) {
        void Promise.resolve(onPostCreated(result.post)).catch(() => undefined);
      }
    } catch (cause) {
      setError(
        cause instanceof PostOutcomeUnknownError
          ? t("composer.postOutcomeUnknown")
          : errorMessage(cause, t("composer.postFailed"), t("composer.uploadCancelled")),
      );
    } finally {
      if (submitInFlight.current === pending) submitInFlight.current = undefined;
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (files.length === 0) return;
    try {
      const attachments = createDraftAttachments(draft.attachments.length, files);
      setDraft((current) => ({
        ...current,
        attachments: [...current.attachments, ...attachments],
      }));
      setError(undefined);
    } catch (cause) {
      setError(validationMessage(cause, t));
    }
  }

  function updateAttachment(
    localId: string,
    update: (attachment: DraftAttachment) => DraftAttachment,
  ): void {
    setDraft((current) => {
      const existing = current.attachments.find((attachment) => attachment.localId === localId);
      if (existing === undefined) return current;
      const updated = update(existing);
      return replaceAttachment(current, updated);
    });
  }

  async function upload(attachment: DraftAttachment): Promise<void> {
    setError(undefined);
    try {
      await coordinator.confirm(attachment);
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          t("composer.uploadFailed", { filename: attachment.file.name }),
          t("composer.uploadCancelled"),
        ),
      );
    }
  }

  async function retry(attachment: DraftAttachment): Promise<void> {
    setError(undefined);
    try {
      await coordinator.retry(attachment.localId);
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          t("composer.uploadFailed", { filename: attachment.file.name }),
          t("composer.uploadCancelled"),
        ),
      );
    }
  }

  async function remove(attachment: DraftAttachment): Promise<void> {
    setError(undefined);
    try {
      await coordinator.remove(attachment.localId);
      setDraft((current) => ({
        ...current,
        attachments: current.attachments.filter(({ localId }) => localId !== attachment.localId),
      }));
    } catch (cause) {
      setError(errorMessage(cause, t("media.deleteFailed"), t("composer.uploadCancelled")));
    }
  }

  function cancel(attachment: DraftAttachment): void {
    coordinator.abort(attachment.localId);
    setError(t("composer.uploadCancelled"));
  }

  return (
    <form
      aria-label={t("composer.create")}
      className="composer"
      onSubmit={(event) => void submit(event)}
    >
      <fieldset>
        <legend>{t("composer.create")}</legend>
        <label>
          {t("composer.content")}
          <textarea
            aria-describedby={reasonId(controlId, "content", contentDecision)}
            aria-label={t("composer.content")}
            disabled={mutation.isPending || !contentDecision.enabled}
            onChange={(event) =>
              setDraft((current) => ({ ...current, content: event.currentTarget.value }))
            }
            value={draft.content}
          />
          <DecisionReason control="content" controlId={controlId} decision={contentDecision} />
        </label>

        <ControlField
          control="visibility"
          controlId={controlId}
          controls={controls}
          label={t("composer.visibility")}
        >
          {(decision, descriptionId) => (
            <select
              aria-describedby={descriptionId}
              aria-label={t("composer.visibility")}
              disabled={mutation.isPending || !decision.enabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  visibility: event.currentTarget.value as ComposerVisibility,
                }))
              }
              value={draft.visibility}
            >
              {allowedVisibilities.map((visibility) => (
                <option key={visibility} value={visibility}>
                  {t(`composer.visibility.${visibility}`)}
                </option>
              ))}
            </select>
          )}
        </ControlField>

        <ControlField
          control="contentWarning"
          controlId={controlId}
          controls={controls}
          label={t("composer.contentWarning")}
        >
          {(decision, descriptionId) => (
            <input
              aria-describedby={descriptionId}
              aria-label={t("composer.contentWarning")}
              disabled={mutation.isPending || !decision.enabled}
              onChange={(event) =>
                setDraft((current) => ({ ...current, summary: event.currentTarget.value }))
              }
              type="text"
              value={draft.summary}
            />
          )}
        </ControlField>

        <ControlField
          control="sensitive"
          controlId={controlId}
          controls={controls}
          label={t("composer.sensitive")}
        >
          {(decision, descriptionId) => (
            <input
              aria-describedby={descriptionId}
              aria-label={t("composer.sensitive")}
              checked={draft.sensitive}
              disabled={mutation.isPending || !decision.enabled}
              onChange={(event) =>
                setDraft((current) => ({ ...current, sensitive: event.currentTarget.checked }))
              }
              type="checkbox"
            />
          )}
        </ControlField>

        <ControlField
          control="reply"
          controlId={controlId}
          controls={controls}
          label={t("composer.replyTo")}
        >
          {(decision, descriptionId) => (
            <input
              aria-describedby={descriptionId}
              aria-label={t("composer.replyTo")}
              disabled={mutation.isPending || !decision.enabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ...optionalTarget("replyToId", event.currentTarget.value),
                }))
              }
              type="text"
              value={draft.replyToId ?? ""}
            />
          )}
        </ControlField>

        <ControlField
          control="quote"
          controlId={controlId}
          controls={controls}
          label={t("composer.quotePost")}
        >
          {(decision, descriptionId) => (
            <input
              aria-describedby={descriptionId}
              aria-label={t("composer.quotePost")}
              disabled={mutation.isPending || !decision.enabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ...optionalTarget("quoteOfId", event.currentTarget.value),
                }))
              }
              type="text"
              value={draft.quoteOfId ?? ""}
            />
          )}
        </ControlField>

        <ControlField
          control="upload"
          controlId={controlId}
          controls={controls}
          label={t("composer.addImages")}
        >
          {(decision, descriptionId) => (
            <input
              accept={[...acceptedImageTypes].join(",")}
              aria-describedby={descriptionId}
              aria-label={t("composer.addImages")}
              disabled={mutation.isPending || !decision.enabled}
              multiple
              onChange={selectFiles}
              type="file"
            />
          )}
        </ControlField>

        {draft.attachments.length === 0 ? null : (
          <ul aria-label={t("composer.imageAttachments")} className="composer__attachments">
            {draft.attachments.map((attachment) => (
              <AttachmentEditor
                attachment={attachment}
                key={attachment.localId}
                onAltText={(altText) =>
                  updateAttachment(attachment.localId, (current) => ({ ...current, altText }))
                }
                onCancel={() => cancel(attachment)}
                onRemove={() => void remove(attachment)}
                onRetry={() => void retry(attachment)}
                onUpload={() => void upload(attachment)}
                submitting={mutation.isPending}
                t={t}
              />
            ))}
          </ul>
        )}

        {error === undefined ? null : (
          <p className="form-message form-message--error" role="alert">
            {error}
          </p>
        )}

        <button
          aria-describedby={reasonId(controlId, "create", createDecision)}
          disabled={submitDisabled}
          type="submit"
        >
          {mutation.isPending ? t("composer.posting") : t("composer.submit")}
        </button>
        <DecisionReason control="create" controlId={controlId} decision={createDecision} />
      </fieldset>
    </form>
  );
}

function visibleVisibilities(
  supportedVisibilities: readonly ComposerVisibility[] | undefined,
): readonly ComposerVisibility[] {
  if (supportedVisibilities === undefined) return visibilityOptions;
  const allowed = visibilityOptions.filter((visibility) =>
    supportedVisibilities.includes(visibility),
  );
  return allowed.length === 0 ? ["public"] : allowed;
}

function normalizeDraftForControls(
  draft: ComposerDraft,
  controls: {
    readonly allowedVisibilities: readonly ComposerVisibility[];
    readonly content: boolean;
    readonly contentWarning: boolean;
    readonly sensitive: boolean;
  },
): ComposerDraft {
  const visibility = controls.allowedVisibilities.includes(draft.visibility)
    ? draft.visibility
    : controls.allowedVisibilities[0];
  const content = controls.content ? draft.content : "";
  const summary = controls.contentWarning ? draft.summary : "";
  const sensitive = controls.sensitive ? draft.sensitive : false;
  return visibility === draft.visibility &&
    content === draft.content &&
    summary === draft.summary &&
    sensitive === draft.sensitive
    ? draft
    : { ...draft, visibility, content, summary, sensitive };
}

interface AttachmentEditorProps {
  readonly attachment: DraftAttachment;
  readonly onAltText: (altText: string) => void;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
  readonly onUpload: () => void;
  readonly submitting: boolean;
  readonly t: ReturnType<typeof useI18n>["t"];
}

function AttachmentEditor({
  attachment,
  onAltText,
  onCancel,
  onRemove,
  onRetry,
  onUpload,
  submitting,
  t,
}: AttachmentEditorProps): ReactElement {
  const filename = attachment.file.name;
  return (
    <li className="composer__attachment">
      <img
        alt={attachment.altText || filename}
        className="composer__preview"
        src={attachment.remoteUrl ?? attachment.previewUrl}
      />
      <label>
        {t("composer.altText", { filename })}
        <input
          aria-label={t("composer.altText", { filename })}
          onChange={(event) => onAltText(event.currentTarget.value)}
          readOnly={
            submitting || attachment.status === "uploading" || attachment.status === "uploaded"
          }
          type="text"
          value={attachment.altText}
        />
      </label>
      <UploadStatus attachment={attachment} t={t} />
      {attachment.status === "draft" ? (
        <button disabled={submitting} onClick={onUpload} type="button">
          {t("composer.uploadImage", { filename })}
        </button>
      ) : null}
      {attachment.status === "uploading" ? (
        <button onClick={onCancel} type="button">
          {t("composer.cancelUpload", { filename })}
        </button>
      ) : null}
      {attachment.status === "failed" ? (
        <button disabled={submitting} onClick={onRetry} type="button">
          {t("composer.retryUpload", { filename })}
        </button>
      ) : null}
      <button disabled={submitting} onClick={onRemove} type="button">
        {t("composer.removeImage", { filename })}
      </button>
    </li>
  );
}

function UploadStatus({
  attachment,
  t,
}: {
  readonly attachment: DraftAttachment;
  readonly t: ReturnType<typeof useI18n>["t"];
}): ReactElement {
  const filename = attachment.file.name;
  if (attachment.status === "uploading") {
    return (
      <div aria-live="polite">
        <progress aria-label={t("composer.uploading", { filename })} />
        <span>{t("composer.uploading", { filename })}</span>
      </div>
    );
  }
  if (attachment.status === "uploaded") {
    return (
      <div aria-live="polite">
        <progress aria-label={t("composer.uploaded", { filename })} max={100} value={100} />
        <span>{t("composer.uploaded", { filename })}</span>
      </div>
    );
  }
  if (attachment.status === "failed") {
    return (
      <p aria-live="polite">
        {attachment.error === "Upload cancelled."
          ? t("composer.uploadCancelled")
          : (attachment.error ?? t("composer.uploadFailed", { filename }))}
      </p>
    );
  }
  return <p aria-live="polite">{t("composer.readyToUpload", { filename })}</p>;
}

interface ControlFieldProps {
  readonly children: (
    decision: ComposerControlDecision,
    reasonId: string | undefined,
  ) => ReactElement;
  readonly control: ComposerControl;
  readonly controlId: string;
  readonly controls: ComposerControlDecisions | undefined;
  readonly label: string;
}

function ControlField({
  children,
  control,
  controlId,
  controls,
  label,
}: ControlFieldProps): ReactElement {
  const decision = decisionFor(controls, control);
  return (
    <div className="composer__control">
      <span>{label}</span>
      {children(decision, reasonId(controlId, control, decision))}
      <DecisionReason control={control} controlId={controlId} decision={decision} />
    </div>
  );
}

function DecisionReason({
  control,
  controlId,
  decision,
}: {
  readonly control: ComposerControl;
  readonly controlId: string;
  readonly decision: ComposerControlDecision;
}): ReactElement | null {
  if (decision.enabled || decision.reason === undefined) return null;
  return (
    <p className="control-reason" id={reasonId(controlId, control, decision)}>
      {decision.reason}
    </p>
  );
}

function decisionFor(
  decisions: ComposerControlDecisions | undefined,
  control: ComposerControl,
): ComposerControlDecision {
  return decisions?.[control] ?? { enabled: true };
}

function reasonId(
  prefix: string,
  control: ComposerControl,
  decision: ComposerControlDecision,
): string | undefined {
  return decision.enabled || decision.reason === undefined
    ? undefined
    : `${prefix}-${control}-reason`;
}

function replaceAttachment(draft: ComposerDraft, replacement: DraftAttachment): ComposerDraft {
  if (!draft.attachments.some(({ localId }) => localId === replacement.localId)) return draft;
  return {
    ...draft,
    attachments: draft.attachments.map((attachment) =>
      attachment.localId === replacement.localId ? replacement : attachment,
    ),
  };
}

function clearSubmittedDraft(current: ComposerDraft, snapshot: ComposerDraft): ComposerDraft {
  const empty = createEmptyComposerDraft();
  const submittedAttachmentIds = new Set(
    snapshot.attachments.map((attachment) => attachment.localId),
  );
  return {
    content: current.content === snapshot.content ? empty.content : current.content,
    visibility: current.visibility === snapshot.visibility ? empty.visibility : current.visibility,
    summary: current.summary === snapshot.summary ? empty.summary : current.summary,
    sensitive: current.sensitive === snapshot.sensitive ? empty.sensitive : current.sensitive,
    ...(current.replyToId === snapshot.replyToId || current.replyToId === undefined
      ? {}
      : { replyToId: current.replyToId }),
    ...(current.quoteOfId === snapshot.quoteOfId || current.quoteOfId === undefined
      ? {}
      : { quoteOfId: current.quoteOfId }),
    attachments: current.attachments.filter(
      (attachment) => !submittedAttachmentIds.has(attachment.localId),
    ),
  };
}

function optionalTarget(
  field: "replyToId" | "quoteOfId",
  value: string,
): Pick<ComposerDraft, "replyToId" | "quoteOfId"> {
  const normalized = value.trim();
  return normalized === "" ? { [field]: undefined } : { [field]: normalized };
}

function validationMessage(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (!(error instanceof ComposerValidationError))
    return errorMessage(error, t("composer.postFailed"));
  switch (error.code) {
    case "TOO_MANY_IMAGES":
      return t("composer.tooManyImages");
    case "IMAGE_TOO_LARGE":
      return t("composer.imageTooLarge");
    case "UNSUPPORTED_IMAGE_TYPE":
      return t("composer.unsupportedImage");
  }
  return errorMessage(error, t("composer.postFailed"));
}

function errorMessage(error: unknown, fallback: string, aborted = fallback): string {
  if (error instanceof DOMException && error.name === "AbortError") return aborted;
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

function isPostOutcomeUnknown(error: unknown): boolean {
  if (error instanceof ComposerValidationError) return false;
  if (!(error instanceof WebApiError)) return true;
  if (error.status !== undefined && error.status >= 400 && error.status < 500) return false;
  return !definitePostFailureCodes.has(error.code);
}
