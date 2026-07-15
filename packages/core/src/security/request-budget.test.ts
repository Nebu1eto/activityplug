import { afterEach, describe, expect, it, vi } from "vitest";

import { BudgetScope } from "./budget.js";
import { budgetResponseBody, createBudgetedFetch } from "./request-budget.js";

afterEach(() => {
  vi.useRealTimers();
});

function deadlineBudget(): BudgetScope {
  return new BudgetScope({ operation: "test", limits: { deadline: 100 } });
}

describe("budgetResponseBody", () => {
  it("completes exactly once at EOF, including across clones", async () => {
    const budget = new BudgetScope({ operation: "test" });
    const reservation = budget.reserve("concurrency");
    const complete = vi.fn();
    const response = budgetResponseBody(new Response("body"), budget, () => {
      complete();
      reservation.release();
    });
    const clone = response.clone();

    expect(complete).not.toHaveBeenCalled();
    expect(budget.snapshot().used.concurrency).toBe(1);
    await expect(Promise.all([response.text(), clone.text()])).resolves.toEqual(["body", "body"]);
    expect(complete).toHaveBeenCalledOnce();
    expect(budget.snapshot().used.concurrency).toBe(0);
  });

  it("completes exactly once when the consumer cancels repeatedly", async () => {
    const budget = new BudgetScope({ operation: "test" });
    const reservation = budget.reserve("concurrency");
    const complete = vi.fn();
    const response = budgetResponseBody(
      new Response(new ReadableStream<Uint8Array>({ pull() {} })),
      budget,
      () => {
        complete();
        reservation.release();
      },
    );

    expect(budget.snapshot().used.concurrency).toBe(1);
    await response.body?.cancel("stop");
    await response.body?.cancel("stop again");
    expect(complete).toHaveBeenCalledOnce();
    expect(budget.snapshot().used.concurrency).toBe(0);
  });

  it("completes exactly once when the source errors", async () => {
    const budget = new BudgetScope({ operation: "test" });
    const reservation = budget.reserve("concurrency");
    const complete = vi.fn();
    const expected = new TypeError("source failed");
    const response = budgetResponseBody(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(expected);
          },
        }),
      ),
      budget,
      () => {
        complete();
        reservation.release();
      },
    );

    expect(budget.snapshot().used.concurrency).toBe(1);
    await expect(response.text()).rejects.toBe(expected);
    expect(complete).toHaveBeenCalledOnce();
    expect(budget.snapshot().used.concurrency).toBe(0);
  });

  it("completes immediately for a null body", () => {
    const budget = new BudgetScope({ operation: "test" });
    const complete = vi.fn();

    expect(
      budgetResponseBody(new Response(null, { status: 204 }), budget, complete).body,
    ).toBeNull();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("aborts a pending fetch when an enforced deadline expires", async () => {
    vi.useFakeTimers();
    let request: Request | undefined;
    const transport = vi.fn<typeof fetch>((input) => {
      request = input instanceof Request ? input : new Request(input);
      return new Promise<Response>(() => undefined);
    });
    const budget = new BudgetScope({ operation: "test", limits: { deadline: 10 } });
    const pending = createBudgetedFetch(transport, budget)("https://social.example/data");
    const rejected = expect(pending).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      dimension: "deadline",
    });

    await vi.advanceTimersByTimeAsync(11);

    await rejected;
    expect(request?.signal.aborted).toBe(true);
    expect(request?.signal.reason).toMatchObject({ dimension: "deadline" });
    expect(budget.snapshot().used.concurrency).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and cancels a response stream when its enforced deadline expires", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {},
            cancel,
          }),
        ),
      ),
    );
    const budget = new BudgetScope({ operation: "test", limits: { deadline: 10 } });
    const response = await createBudgetedFetch(transport, budget)("https://social.example/data");
    const body = response.text();
    const rejected = expect(body).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      dimension: "deadline",
    });

    expect(budget.snapshot().used.concurrency).toBe(1);
    await vi.advanceTimersByTimeAsync(11);

    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(budget.snapshot().used.concurrency).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes deadline exhaustion without aborting pending I/O", async () => {
    vi.useFakeTimers();
    const telemetry = vi.fn();
    let resolveTransport: ((response: Response) => void) | undefined;
    let request: Request | undefined;
    const transport = vi.fn<typeof fetch>((input) => {
      request = input instanceof Request ? input : new Request(input);
      return new Promise<Response>((resolve) => {
        resolveTransport = resolve;
      });
    });
    const budget = new BudgetScope({
      mode: "observe",
      operation: "test",
      limits: { deadline: 10 },
      telemetry,
    });
    const pending = createBudgetedFetch(transport, budget)("https://social.example/data");

    await vi.advanceTimersByTimeAsync(11);

    expect(request?.signal.aborted).toBe(false);
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: "deadline", result: "exhausted" }),
    );
    expect(vi.getTimerCount()).toBe(0);
    resolveTransport?.(new Response(null, { status: 204 }));
    await expect(pending).resolves.toMatchObject({ status: 204 });
    expect(budget.snapshot().used.concurrency).toBe(0);
  });

  it("clears the deadline timer after EOF and preserves caller abort reasons", async () => {
    vi.useFakeTimers();
    const budget = new BudgetScope({ operation: "test", limits: { deadline: 100 } });
    const fetch = createBudgetedFetch(
      vi.fn<typeof globalThis.fetch>(async () => new Response("ok")),
      budget,
    );

    await expect((await fetch("https://social.example/data")).text()).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);

    const abortController = new AbortController();
    const reason = new TypeError("caller cancelled");
    const pending = createBudgetedFetch(
      vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined)),
      new BudgetScope({ operation: "test", limits: { deadline: 100 } }),
    )("https://social.example/data", { signal: abortController.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    abortController.abort(reason);

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears deadline timers after cancellation, source errors, and fetch failures", async () => {
    vi.useFakeTimers();

    const cancelled = await createBudgetedFetch(
      vi.fn<typeof globalThis.fetch>(async () =>
        Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull() {} }))),
      ),
      deadlineBudget(),
    )("https://social.example/data");
    await cancelled.body?.cancel("done");
    expect(vi.getTimerCount()).toBe(0);

    const sourceError = new TypeError("source failed");
    const errored = await createBudgetedFetch(
      vi.fn<typeof globalThis.fetch>(async () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(sourceError);
              },
            }),
          ),
        ),
      ),
      deadlineBudget(),
    )("https://social.example/data");
    await expect(errored.text()).rejects.toBe(sourceError);
    expect(vi.getTimerCount()).toBe(0);

    const fetchError = new TypeError("fetch failed");
    await expect(
      createBudgetedFetch(
        vi.fn<typeof globalThis.fetch>(async () => Promise.reject(fetchError)),
        deadlineBudget(),
      )("https://social.example/data"),
    ).rejects.toBe(fetchError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
