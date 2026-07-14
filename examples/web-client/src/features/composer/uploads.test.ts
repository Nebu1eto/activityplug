import { beforeEach, describe, expect, it, vi } from "vitest";

import { type DraftAttachment } from "../../state/composer.js";
import {
  ComposerValidationError,
  UploadCoordinator,
  createDraftAttachment,
  disposeActiveUploadCoordinators,
  prepareActiveUploadCoordinatorsForLogout,
  registerUploadCoordinator,
  validateImageFiles,
  type MediaUploadPort,
} from "./uploads.js";

describe("composer image validation", () => {
  it.each(["image/svg+xml", "text/html"])(
    "rejects unsupported MIME type %s before preview",
    (type) => {
      expect(() => validateImageFiles(0, [imageFile("unsafe", 1, type)])).toThrow(
        new ComposerValidationError("UNSUPPORTED_IMAGE_TYPE"),
      );
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    },
  );
});

describe("UploadCoordinator", () => {
  beforeEach(() => {
    vi.mocked(URL.createObjectURL).mockImplementation((file) => `blob:${(file as File).name}`);
  });

  it("revokes the local URL after confirmed upload and when a draft is removed", async () => {
    const port = mediaPort();
    const coordinator = new UploadCoordinator(port);
    const first = attachment("draft-1", "one.png", "blob:one", "First alt");
    const second = attachment("draft-2", "two.png", "blob:two", "Second alt");

    await coordinator.confirm(first);
    await coordinator.remove(second);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([["blob:one"], ["blob:two"]]);
  });

  it("aborts an in-flight upload and preserves the draft for retry", async () => {
    const port = mediaPort({
      uploadMedia: vi.fn((_input, signal) => abortableNever(signal)),
    });
    const coordinator = new UploadCoordinator(port);
    const pending = coordinator.confirm(attachment("draft-1", "one.png", "blob:one", "Alt"));

    coordinator.abort("draft-1");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.get("draft-1")).toMatchObject({
      status: "failed",
      altText: "Alt",
      error: "Upload cancelled.",
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one");
  });

  it("retries one failed upload with the unchanged final description", async () => {
    const uploadMedia = vi
      .fn<MediaUploadPort["uploadMedia"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ id: "media-1", remoteUrl: "https://cdn.test/one.png" });
    const coordinator = new UploadCoordinator(mediaPort({ uploadMedia }));

    await expect(
      coordinator.confirm(attachment("draft-1", "one.png", "blob:one", "Final alt")),
    ).rejects.toThrow("offline");
    await coordinator.retry("draft-1");

    expect(uploadMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Final alt" }),
      expect.any(AbortSignal),
    );
    expect(coordinator.get("draft-1")).toMatchObject({
      status: "uploaded",
      mediaId: "media-1",
    });
  });

  it("deletes abandoned remote media only when media.delete is supported", async () => {
    const deleteMedia = vi.fn(async () => undefined);
    const port = mediaPort({ deleteMedia });
    const supported = new UploadCoordinator(port, { canDeleteMedia: true });
    const unsupported = new UploadCoordinator(port, { canDeleteMedia: false });

    await supported.remove(uploadedAttachment("draft-1", "media-1"));
    await unsupported.remove(uploadedAttachment("draft-2", "media-2"));

    expect(deleteMedia).toHaveBeenCalledOnce();
    expect(deleteMedia).toHaveBeenCalledWith("media-1");
  });

  it("preserves uploaded state when remote cleanup fails", async () => {
    const coordinator = new UploadCoordinator(
      mediaPort({
        deleteMedia: vi.fn(async () => {
          throw new Error("cleanup unavailable");
        }),
      }),
      { canDeleteMedia: true },
    );
    const uploaded = uploadedAttachment("draft-1", "media-1");

    await expect(coordinator.remove(uploaded)).rejects.toThrow("cleanup unavailable");

    expect(coordinator.get("draft-1")).toMatchObject({
      status: "uploaded",
      mediaId: "media-1",
      error: "cleanup unavailable",
    });
  });

  it("removes held unknown-outcome media locally without deleting it remotely", async () => {
    const deleteMedia = vi.fn(async () => undefined);
    const coordinator = new UploadCoordinator(mediaPort({ deleteMedia }), {
      canDeleteMedia: true,
    });
    const uploaded = uploadedAttachment("draft-1", "media-1");
    coordinator.hold([uploaded]);

    await coordinator.remove(uploaded);
    await coordinator.dispose();

    expect(coordinator.get("draft-1")).toBeUndefined();
    expect(deleteMedia).not.toHaveBeenCalled();
  });

  it("resolves removal from current tracked state instead of a stale object", async () => {
    const deleteMedia = vi.fn(async () => undefined);
    const coordinator = new UploadCoordinator(mediaPort({ deleteMedia }), {
      canDeleteMedia: true,
    });
    const stale = attachment("draft-1", "one.png", "blob:one", "Alt");
    coordinator.track(uploadedAttachment("draft-1", "media-1"));

    await coordinator.remove(stale);

    expect(deleteMedia).toHaveBeenCalledWith("media-1");
  });

  it("does not resurrect an attachment removed during upload", async () => {
    const upload = Promise.withResolvers<{ readonly id: string; readonly remoteUrl: string }>();
    const deleteMedia = vi.fn(async () => undefined);
    const uploadMedia = vi.fn(() => upload.promise);
    const coordinator = new UploadCoordinator(mediaPort({ uploadMedia, deleteMedia }), {
      canDeleteMedia: true,
    });
    const draft = attachment("draft-1", "one.png", "blob:one", "Alt");
    const pending = coordinator.confirm(draft);

    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    await coordinator.remove(draft);
    upload.resolve({ id: "late-media", remoteUrl: "https://cdn.test/late.png" });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.get("draft-1")).toBeUndefined();
    expect(deleteMedia).toHaveBeenCalledWith("late-media");
  });

  it("aborts and revokes tracked previews when disposed", async () => {
    const port = mediaPort({
      uploadMedia: vi.fn((_input, signal) => abortableNever(signal)),
    });
    const coordinator = new UploadCoordinator(port);
    const draft = createDraftAttachment(imageFile("one.png", 1));
    const pending = coordinator.confirm(draft);

    await coordinator.dispose();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one.png");
  });

  it("aborts and revokes a mounted coordinator at an account boundary", async () => {
    const port = mediaPort({
      uploadMedia: vi.fn((_input, signal) => abortableNever(signal)),
    });
    const coordinator = new UploadCoordinator(port);
    registerUploadCoordinator(coordinator);
    const pending = coordinator.confirm(attachment("draft-1", "one.png", "blob:one", "Alt"));

    await disposeActiveUploadCoordinators();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one");
  });

  it("prepares a mounted coordinator for logout without disposing it", async () => {
    const deleteMedia = vi.fn(async () => undefined);
    const coordinator = new UploadCoordinator(mediaPort({ deleteMedia }), {
      canDeleteMedia: true,
    });
    const unregister = registerUploadCoordinator(coordinator);
    const updates: DraftAttachment[] = [];
    const unsubscribe = coordinator.subscribe((updatedAttachment) =>
      updates.push(updatedAttachment),
    );
    const unheld = uploadedAttachment("unheld", "unheld-media");
    const held = uploadedAttachment("held", "held-media");
    coordinator.track(unheld);
    coordinator.hold([held]);

    try {
      await prepareActiveUploadCoordinatorsForLogout();

      expect(deleteMedia).toHaveBeenCalledWith("unheld-media");
      expect(deleteMedia).not.toHaveBeenCalledWith("held-media");
      expect(coordinator.get("unheld")).toBeUndefined();
      expect(coordinator.get("held")).toEqual(held);
      expect(updates).toContainEqual(
        expect.objectContaining({ localId: "unheld", status: "draft" }),
      );
      await expect(
        coordinator.confirm(attachment("new-draft", "new.png", "blob:new", "New alt")),
      ).resolves.toMatchObject({ status: "uploaded", mediaId: "media-1" });
    } finally {
      unsubscribe();
      unregister();
      await coordinator.dispose();
    }
  });

  it("bounds logout preparation when media cleanup never settles", async () => {
    vi.useFakeTimers();
    const cleanup = Promise.withResolvers<void>();
    const coordinator = new UploadCoordinator(
      mediaPort({ deleteMedia: vi.fn(() => cleanup.promise) }),
      { canDeleteMedia: true },
    );
    coordinator.track(uploadedAttachment("draft-1", "media-1"));

    try {
      const preparation = coordinator.prepareForLogout();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(preparation).resolves.toBeUndefined();
      expect(coordinator.get("draft-1")).toBeUndefined();
      cleanup.reject(new Error("Remote cleanup failed after logout continued."));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});

beforeEach(() => {
  Object.defineProperties(URL, {
    createObjectURL: {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`),
    },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
});

function imageFile(name: string, size: number, type = "image/png"): File {
  const file = new File([], name, { type });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

function attachment(localId: string, filename: string, previewUrl: string, altText: string) {
  return {
    localId,
    file: imageFile(filename, 1),
    previewUrl,
    altText,
    status: "draft" as const,
  };
}

function uploadedAttachment(localId: string, mediaId: string) {
  return {
    ...attachment(localId, `${localId}.png`, `blob:${localId}`, "Alt"),
    status: "uploaded" as const,
    mediaId,
    remoteUrl: `https://cdn.test/${mediaId}.png`,
  };
}

function mediaPort(overrides: Partial<MediaUploadPort> = {}): MediaUploadPort {
  return {
    uploadMedia: vi.fn(async () => ({
      id: "media-1",
      remoteUrl: "https://cdn.test/media-1.png",
    })),
    deleteMedia: vi.fn(async () => undefined),
    ...overrides,
  };
}

function abortableNever(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });
}
