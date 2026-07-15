import { ActivityPlugError } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REQUEST_LIMITS,
  readBoundedBodyBytes,
  readBoundedBodyText,
  readGraphQLRequestBytes,
  readJsonRequestBytes,
  resolveMultipartConstraints,
  resolveRequestLimits,
  validateMultipartPayload,
} from "./request-limits.js";

const encoder = new TextEncoder();
const maxBodyReads = 4_096;

function streamRequest(body: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
  return new Request("https://activityplug.test/body", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

describe("request limit configuration", () => {
  it("uses the exact server-owned defaults and freezes resolved limits", () => {
    expect(DEFAULT_REQUEST_LIMITS).toEqual({
      jsonBytes: 1_048_576,
      graphqlBytes: 1_048_576,
      multipartBytes: 67_108_864,
      multipartFiles: 4,
      multipartFileBytes: 16_777_216,
      remoteStructuredBytes: 16_777_216,
      websocketBufferedBytes: 1_048_576,
      websocketQueuedEvents: 256,
    });

    const resolved = resolveRequestLimits({ jsonBytes: 512 });
    expect(resolved).toEqual({ ...DEFAULT_REQUEST_LIMITS, jsonBytes: 512 });
    expect(Object.isFrozen(DEFAULT_REQUEST_LIMITS)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects unsafe request limit %s",
    (value) => {
      expect(() => resolveRequestLimits({ jsonBytes: value })).toThrow(TypeError);
    },
  );

  it("rejects a per-file limit above the total multipart limit", () => {
    expect(() => resolveRequestLimits({ multipartBytes: 10, multipartFileBytes: 11 })).toThrow(
      /multipartFileBytes/u,
    );
  });

  it("rejects unknown override keys instead of retaining them", () => {
    expect(() =>
      resolveRequestLimits({
        jsonByte: 1,
      } as unknown as Partial<typeof DEFAULT_REQUEST_LIMITS>),
    ).toThrow(/jsonByte/u);
  });
});

describe("bounded body reading", () => {
  it("rejects a trustworthy oversized Content-Length before reading", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const request = streamRequest(
      new ReadableStream({
        pull,
        cancel,
      }),
      { "content-length": "5" },
    );

    await expect(readBoundedBodyBytes(request, 4)).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["9007199254740992", "9999999999999999999999999999999999999999"])(
    "early-rejects oversized digit-only Content-Length %s",
    async (declaredLength) => {
      const request = new Request("https://activityplug.test/body", {
        method: "POST",
        headers: { "content-length": declaredLength },
        body: "1",
      });

      await expect(readBoundedBodyBytes(request, 4)).rejects.toMatchObject({
        code: "REQUEST_LIMIT_EXCEEDED",
      });
    },
  );

  it("does not trust a small Content-Length over the actual bytes", async () => {
    const request = new Request("https://activityplug.test/body", {
      method: "POST",
      headers: { "content-length": "1" },
      body: "12345",
    });

    await expect(readBoundedBodyBytes(request, 4)).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
    });
  });

  it("rejects chunked overshoot without retaining the over-limit chunk", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("1234"));
        controller.enqueue(encoder.encode("5secret"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedBodyBytes(stream, 4)).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
    });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it.each([maxBodyReads - 1, maxBodyReads])(
    "accepts %s non-empty body reads at and below the read boundary",
    async (readCount) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < readCount; index += 1) {
            controller.enqueue(encoder.encode("x"));
          }
          controller.close();
        },
      });

      const bytes = await readBoundedBodyBytes(stream, maxBodyReads + 1);

      expect(bytes.byteLength).toBe(readCount);
      expect(bytes.every((byte) => byte === 120)).toBe(true);
      expect(stream.locked).toBe(false);
    },
  );

  it("rejects and cancels one non-empty body read above the read boundary", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index <= maxBodyReads; index += 1) {
          controller.enqueue(encoder.encode("x"));
        }
      },
      cancel,
    });

    await expect(readBoundedBodyBytes(stream, maxBodyReads + 1)).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      context: { operation: "request.body", raw: { limit: maxBodyReads + 1 } },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("charges zero-length body values against the read boundary", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index <= maxBodyReads; index += 1) {
          controller.enqueue(new Uint8Array());
        }
      },
      cancel,
    });

    await expect(readBoundedBodyBytes(stream, 1)).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("does not await a hostile stream cancellation", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("12345"));
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });

    const result = Promise.race([
      readBoundedBodyBytes(stream, 4).then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
    ]);

    await expect(result).resolves.toMatchObject({ code: "REQUEST_LIMIT_EXCEEDED" });
    expect(stream.locked).toBe(false);
  });

  it("cancels its body source when the caller signal is already aborted", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const reason = new Error("caller already stopped");
    controller.abort(reason);

    await expect(readBoundedBodyBytes(stream, 4, controller.signal)).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("honors caller abort while a read is pending and releases the lock", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const reading = readBoundedBodyBytes(stream, 4, controller.signal);

    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("decodes UTF-8 characters split across stream chunks", async () => {
    const bytes = encoder.encode("A한글B");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });

    await expect(readBoundedBodyText(stream, bytes.byteLength)).resolves.toBe("A한글B");
  });

  it("provides JSON and GraphQL helpers with their distinct limits", async () => {
    const limits = resolveRequestLimits({ jsonBytes: 2, graphqlBytes: 3 });

    await expect(
      readJsonRequestBytes(new Request("https://x", { method: "POST", body: "123" }), limits),
    ).rejects.toBeInstanceOf(ActivityPlugError);
    await expect(
      readGraphQLRequestBytes(new Request("https://x", { method: "POST", body: "123" }), limits),
    ).resolves.toEqual(encoder.encode("123"));
  });
});

describe("multipart constraint helpers", () => {
  it("intersects configured limits with stricter advertised limits", () => {
    const constraints = resolveMultipartConstraints(DEFAULT_REQUEST_LIMITS, {
      multipartBytes: 1_000,
      multipartFiles: 2,
      multipartFileBytes: 500,
      acceptedMimeTypes: ["image/png"],
    });

    expect(constraints).toEqual({
      multipartBytes: 1_000,
      multipartFiles: 2,
      multipartFileBytes: 500,
      acceptedMimeTypes: ["image/png"],
    });
    expect(Object.isFrozen(constraints)).toBe(true);
    expect(Object.isFrozen(constraints.acceptedMimeTypes)).toBe(true);
  });

  it("rejects file count, individual size, total size, and MIME violations", () => {
    const constraints = {
      multipartBytes: 10,
      multipartFiles: 1,
      multipartFileBytes: 4,
      acceptedMimeTypes: ["image/png"],
    } as const;

    expect(() =>
      validateMultipartPayload(5, [{ byteLength: 1, mimeType: "image/png" }], constraints),
    ).not.toThrow();
    expect(() =>
      validateMultipartPayload(
        5,
        [
          { byteLength: 1, mimeType: "image/png" },
          { byteLength: 1, mimeType: "image/png" },
        ],
        constraints,
      ),
    ).toThrow(/file count/u);
    expect(() =>
      validateMultipartPayload(5, [{ byteLength: 5, mimeType: "image/png" }], constraints),
    ).toThrow(/file byte/u);
    expect(() =>
      validateMultipartPayload(11, [{ byteLength: 1, mimeType: "image/png" }], constraints),
    ).toThrow(/total byte/u);
    expect(() =>
      validateMultipartPayload(5, [{ byteLength: 1, mimeType: "image/jpeg" }], constraints),
    ).toThrow(/MIME/u);
  });
});
