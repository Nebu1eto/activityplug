import { isBrowserErrorEnvelope, type BrowserErrorEnvelope } from "./contracts.js";

type BrowserError = BrowserErrorEnvelope["error"];
export type WebApiErrorCode =
  | BrowserError["code"]
  | "HTTP_STATUS"
  | "INVALID_CONTENT_TYPE"
  | "MALFORMED_RESPONSE"
  | "MISSING_CSRF"
  | "INVALID_PATH";
export type BrowserResponseShape = "data" | "plain";

export class WebApiError extends Error {
  public constructor(
    public readonly code: WebApiErrorCode,
    message: string,
    public readonly status?: number,
    public readonly details: Partial<Omit<BrowserError, "code" | "message">> = {},
  ) {
    super(message);
    this.name = "WebApiError";
  }
}

export interface BrowserHttp {
  get<T>(path: string, signal?: AbortSignal, shape?: BrowserResponseShape): Promise<T>;
  post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    shape?: BrowserResponseShape,
  ): Promise<T>;
  postForm<T>(
    path: string,
    body: FormData,
    signal?: AbortSignal,
    shape?: BrowserResponseShape,
  ): Promise<T>;
  delete<T>(path: string, signal?: AbortSignal, shape?: BrowserResponseShape): Promise<T>;
  setCsrfToken(value: string): void;
  abortUnsafeRequests(): void;
}

export function createBrowserApi(
  rawFetch: typeof globalThis.fetch = globalThis.fetch,
): BrowserHttp {
  let csrfValue = "";
  const unsafeRequestControllers = new Set<AbortController>();

  async function request<T>(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
    shape: BrowserResponseShape,
  ): Promise<T> {
    const unsafe = method !== "GET";
    if (unsafe && csrfValue === "") {
      throw new WebApiError("MISSING_CSRF", "Load the browser session before an unsafe request.");
    }

    const controller = unsafe ? new AbortController() : undefined;
    const unlinkCallerAbort =
      controller === undefined ? undefined : linkAbortSignal(controller, signal);
    if (controller !== undefined) unsafeRequestControllers.add(controller);

    const headers = new Headers();
    if (unsafe) headers.set("X-ActivityPlug-CSRF", csrfValue);
    if (typeof body === "string") headers.set("content-type", "application/json");
    try {
      const response = await rawFetch(
        new Request(browserUrl(path), {
          method,
          credentials: "same-origin",
          headers,
          ...(body === undefined ? {} : { body }),
          ...((controller ?? signal) === undefined ? {} : { signal: controller?.signal ?? signal }),
        }),
      );
      const isJson = isBrowserJson(response.headers.get("content-type"));

      if (!response.ok) {
        if (isJson) {
          const errorPayload = await readJson(response);
          if (isBrowserErrorEnvelope(errorPayload)) {
            const { code, message, ...details } = errorPayload.error;
            throw new WebApiError(code, message, response.status, details);
          }
          throw new WebApiError(
            "MALFORMED_RESPONSE",
            "Browser API error response is malformed.",
            response.status,
          );
        }
        throw new WebApiError(
          "HTTP_STATUS",
          `Browser API returned HTTP ${response.status}.`,
          response.status,
        );
      }
      if (!isJson) {
        throw new WebApiError(
          "INVALID_CONTENT_TYPE",
          "Browser API did not return JSON.",
          response.status,
        );
      }
      const payload = await readJson(response);
      if (shape === "plain") return payload as T;
      if (typeof payload !== "object" || payload === null || !("data" in payload)) {
        throw new WebApiError(
          "MALFORMED_RESPONSE",
          "Browser API response has no data field.",
          response.status,
        );
      }
      return (payload as { readonly data: T }).data;
    } finally {
      if (controller !== undefined) unsafeRequestControllers.delete(controller);
      unlinkCallerAbort?.();
    }
  }

  return {
    get: (path, signal, shape = "data") => request(path, "GET", undefined, signal, shape),
    post: (path, body, signal, shape = "data") =>
      request(path, "POST", JSON.stringify(body), signal, shape),
    postForm: (path, body, signal, shape = "data") => request(path, "POST", body, signal, shape),
    delete: (path, signal, shape = "data") => request(path, "DELETE", undefined, signal, shape),
    setCsrfToken: (value) => {
      csrfValue = value;
    },
    abortUnsafeRequests: () => {
      for (const controller of unsafeRequestControllers) controller.abort();
    },
  };
}

function linkAbortSignal(
  controller: AbortController,
  callerSignal: AbortSignal | undefined,
): () => void {
  if (callerSignal === undefined) return () => undefined;

  const abort = () => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) {
    abort();
    return () => undefined;
  }
  callerSignal.addEventListener("abort", abort, { once: true });
  return () => callerSignal.removeEventListener("abort", abort);
}

function browserUrl(path: string): URL {
  const origin = globalThis.location?.origin ?? "http://localhost";
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new WebApiError("INVALID_PATH", "Browser API path must be same-origin and relative.");
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) {
    throw new WebApiError("INVALID_PATH", "Browser API path must be same-origin and relative.");
  }
  return url;
}

function isBrowserJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  return /^application\/json(?:\s*;\s*[^;=\s]+=(?:"(?:[^"\\]|\\.)*"|[^;\s]+))*\s*$/iu.test(
    contentType,
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new WebApiError(
      "MALFORMED_RESPONSE",
      "Browser API response contains malformed JSON.",
      response.status,
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}
