import { type BudgetScope } from "./budget.js";

const requestBudgets = new WeakMap<Request, BudgetScope>();
const responseBudgets = new WeakMap<Response, BudgetScope>();

export function setRequestBudget(request: Request, budget: BudgetScope): Request {
  requestBudgets.set(request, budget);
  return request;
}

export function inheritRequestBudget(request: Request, source: Request): Request {
  const budget = requestBudgets.get(source);
  if (budget !== undefined) requestBudgets.set(request, budget);
  return request;
}

export function getRequestBudget(request: Request): BudgetScope | undefined {
  return requestBudgets.get(request);
}

export function markResponseBudgeted(response: Response, budget: BudgetScope): Response {
  responseBudgets.set(response, budget);
  return response;
}

export function isResponseBudgeted(response: Response, budget: BudgetScope): boolean {
  return responseBudgets.get(response) === budget;
}

export function chargeBodyChunk(budget: BudgetScope | undefined, bytes: number): void {
  if (budget === undefined) return;
  budget.checkDeadline();
  budget.charge("reads");
  budget.charge("bytes", bytes);
}

export function budgetResponseBody(
  response: Response,
  budget: BudgetScope,
  onComplete?: () => void,
  signal?: AbortSignal,
): Response {
  if (response.body === null) {
    onComplete?.();
    return response;
  }
  const chargeChunks = !isResponseBudgeted(response, budget);
  const reader = response.body.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = (): void => {
    if (finished || signal === undefined) return;
    const reason = signal.reason;
    finish();
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(releaseReader);
    controller?.error(reason);
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    onComplete?.();
  };
  const releaseReader = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // An outstanding read owns the lock until it settles.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(streamController) {
      if (finished) return;
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          budget.checkDeadline();
          finish();
          releaseReader();
          streamController.close();
          return;
        }
        if (chargeChunks) chargeBodyChunk(budget, value.byteLength);
        streamController.enqueue(value);
      } catch (cause) {
        finish();
        void reader
          .cancel(cause)
          .catch(() => undefined)
          .finally(releaseReader);
        streamController.error(cause);
      }
    },
    cancel(reason) {
      if (finished) return;
      finish();
      void reader
        .cancel(reason)
        .catch(() => undefined)
        .finally(releaseReader);
    },
  });
  const guarded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(guarded, "url", {
    configurable: true,
    enumerable: true,
    value: response.url,
  });
  return markResponseBudgeted(guarded, budget);
}

export function createBudgetedFetch(
  fetch: typeof globalThis.fetch,
  budget: BudgetScope,
): typeof globalThis.fetch {
  return async (input, init) => {
    const inputRequest = new Request(input, init);
    let reservation: ReturnType<BudgetScope["reserve"]> | undefined;
    let deadline: ReturnType<BudgetScope["watchDeadline"]> | undefined;
    let transferred = false;
    let request = inputRequest;
    let response: Response | undefined;
    try {
      budget.checkDeadline();
      budget.charge("requests");
      reservation = budget.reserve("concurrency");
      deadline = budget.watchDeadline();
      if (deadline.signal !== undefined) {
        request = new Request(inputRequest, {
          signal: AbortSignal.any([inputRequest.signal, deadline.signal]),
        });
      }
      setRequestBudget(request, budget);
      response = await fetchResponse(fetch, request);
      budget.checkDeadline();
      const complete = (): void => {
        deadline?.dispose();
        reservation?.release();
      };
      const guarded = budgetResponseBody(response, budget, complete, request.signal);
      transferred = true;
      return guarded;
    } catch (cause) {
      void request.body?.cancel(cause).catch(() => undefined);
      void response?.body?.cancel(cause).catch(() => undefined);
      throw cause;
    } finally {
      if (!transferred) {
        deadline?.dispose();
        reservation?.release();
      }
    }
  };
}

async function fetchResponse(fetch: typeof globalThis.fetch, request: Request): Promise<Response> {
  const signal = request.signal;
  if (signal.aborted) throw signal.reason;
  const response = Promise.resolve().then(() => fetch(request));
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void response.then(
      (value) => {
        if (settled) {
          void value.body?.cancel(signal.reason).catch(() => undefined);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}
