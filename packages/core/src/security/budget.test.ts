import { describe, expect, it, vi } from "vitest";

import { BudgetExhaustedError, BudgetScope, type BudgetTelemetryEvent } from "./budget.js";
import { createBudgetedFetch } from "./request-budget.js";

describe("BudgetScope", () => {
  it("shares counters with nested scopes and lets children only lower limits", () => {
    const root = new BudgetScope({ operation: "post.context", limits: { nodes: 5 } });
    root.charge("nodes", 2);
    const child = root.child({ nodes: 3 });

    child.charge("nodes");
    expect(() => child.charge("nodes")).toThrow(BudgetExhaustedError);
    expect(root.snapshot().used.nodes).toBe(3);
    expect(() => child.child({ nodes: 4 })).toThrowError(
      "Child budget cannot increase the nodes limit.",
    );
  });

  it("releases reservations once without reducing committed charges", () => {
    const budget = new BudgetScope({
      operation: "media.upload",
      limits: { activeAllocations: 2 },
    });
    budget.charge("activeAllocations");
    const reservation = budget.reserve("activeAllocations");

    expect(() => budget.reserve("activeAllocations")).toThrow(BudgetExhaustedError);
    reservation.release();
    reservation.release();
    expect(budget.snapshot().used.activeAllocations).toBe(1);
  });

  it("supports off, observe, and enforce modes and aborts enforced work", () => {
    const events: BudgetTelemetryEvent[] = [];
    const off = new BudgetScope({ mode: "off", operation: "off", limits: { reads: 0 } });
    off.charge("reads", 100);
    expect(off.snapshot().used.reads).toBe(0);

    const observe = new BudgetScope({
      mode: "observe",
      operation: "observe",
      limits: { reads: 1 },
      telemetry: (event) => events.push(event),
    });
    observe.charge("reads", 2);
    expect(observe.snapshot().used.reads).toBe(2);
    expect(events.map(({ result }) => result)).toEqual(["exhausted", "charged"]);

    const abortController = new AbortController();
    const enforce = new BudgetScope({
      operation: "enforce",
      limits: { reads: 1 },
      abortController,
    });
    expect(() => enforce.charge("reads", 2)).toThrow(BudgetExhaustedError);
    expect(enforce.snapshot().used.reads).toBe(0);
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBeInstanceOf(BudgetExhaustedError);
  });

  it("isolates telemetry failures from charges, releases, and error reporting", () => {
    const expected = new TypeError("telemetry failed");
    const telemetryError = vi.fn(() => {
      throw new TypeError("error observer failed");
    });
    const observed = new BudgetScope({
      mode: "observe",
      operation: "observe",
      limits: { reads: 1 },
      telemetry: () => {
        throw expected;
      },
      telemetryError,
    });
    observed.charge("reads", 2);
    const reservation = observed.reserve("concurrency");
    reservation.release();
    reservation.release();

    expect(observed.snapshot().used).toMatchObject({ reads: 2, concurrency: 0 });
    expect(telemetryError).toHaveBeenCalledTimes(4);
    expect(telemetryError).toHaveBeenCalledWith(expected, expect.any(Object));

    const abortController = new AbortController();
    const enforced = new BudgetScope({
      operation: "enforce",
      limits: { reads: 1 },
      telemetry: () => {
        throw expected;
      },
      telemetryError,
      abortController,
    });
    let exhausted: unknown;
    try {
      enforced.charge("reads", 2);
    } catch (cause) {
      exhausted = cause;
    }

    expect(exhausted).toBeInstanceOf(BudgetExhaustedError);
    expect(exhausted).not.toBe(expected);
    expect(enforced.snapshot().used.reads).toBe(0);
    expect(abortController.signal.reason).toBe(exhausted);
    expect(telemetryError).toHaveBeenLastCalledWith(
      expected,
      expect.objectContaining({ result: "exhausted" }),
    );
  });

  it("keeps response completion and cancellation independent from telemetry", async () => {
    const telemetry = vi.fn(() => {
      throw new TypeError("telemetry failed");
    });
    const completedBudget = new BudgetScope({ operation: "complete", telemetry });
    const completed = await createBudgetedFetch(
      vi.fn<typeof globalThis.fetch>(async () => new Response("ok")),
      completedBudget,
    )("https://social.example/data");

    await expect(completed.text()).resolves.toBe("ok");
    expect(completedBudget.snapshot().used.concurrency).toBe(0);

    const cancelledBudget = new BudgetScope({ operation: "cancel", telemetry });
    const cancelled = await createBudgetedFetch(
      vi.fn<typeof globalThis.fetch>(async () =>
        Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull() {} }))),
      ),
      cancelledBudget,
    )("https://social.example/data");

    await expect(cancelled.body?.cancel("done")).resolves.toBeUndefined();
    expect(cancelledBudget.snapshot().used.concurrency).toBe(0);
  });

  it("accounts deadline elapsed time against the shared operation start", () => {
    let now = 1_000;
    const budget = new BudgetScope({
      operation: "timeline.home",
      limits: { deadline: 10 },
      now: () => now,
    });
    const child = budget.child();
    now += 10;
    child.checkDeadline();
    expect(budget.snapshot().used.deadline).toBe(10);
    now += 1;
    expect(() => budget.checkDeadline()).toThrow(BudgetExhaustedError);
  });

  it("absorbs completed nested work into the admitted operation ledger", () => {
    let nestedNow = 0;
    const nested = new BudgetScope({ operation: "instance.detect", now: () => nestedNow });
    nested.charge("requests");
    nested.charge("reads", 2);
    nested.charge("bytes", 4);
    nested.charge("nodes", 3);
    nestedNow = 5;
    nested.checkDeadline();

    let admittedNow = 10;
    const admitted = new BudgetScope({
      operation: "post.get",
      limits: { requests: 2, deadline: 8 },
      now: () => admittedNow,
    });
    admitted.absorb(nested.snapshot());
    admitted.charge("requests");
    admittedNow = 13;
    admitted.checkDeadline();

    expect(admitted.snapshot()).toMatchObject({
      operation: "post.get",
      used: { requests: 2, reads: 2, bytes: 4, nodes: 3, deadline: 8 },
    });
    expect(() => admitted.charge("requests")).toThrow(
      expect.objectContaining({ context: { operation: "post.get" } }),
    );
  });

  it("rejects completed nested work that retains reservations", () => {
    const nested = new BudgetScope({ operation: "instance.detect" });
    nested.reserve("concurrency");
    const admitted = new BudgetScope({ operation: "post.get" });

    expect(() => admitted.absorb(nested.snapshot())).toThrowError(
      "Completed operation budgets must not retain resource reservations.",
    );
  });

  it("keeps telemetry labels independent from varying input values", () => {
    const labels = new Set<string>();
    const telemetry = vi.fn((event: BudgetTelemetryEvent) => {
      labels.add(`${event.operation}:${event.dimension}:${event.result}`);
    });
    const budget = new BudgetScope({
      mode: "observe",
      operation: "search.query",
      limits: { requests: 0 },
      telemetry,
    });

    for (let index = 0; index < 1_000; index += 1) budget.charge("requests");

    expect(telemetry).toHaveBeenCalledTimes(2_000);
    expect(labels).toEqual(
      new Set(["search.query:requests:exhausted", "search.query:requests:charged"]),
    );
  });

  it("performs charges and releases independently of child depth", () => {
    const budget = new BudgetScope({ operation: "deep", limits: { concurrency: 10_000 } });
    let child = budget;
    for (let index = 0; index < 1_000; index += 1) child = child.child();

    for (let index = 0; index < 10_000; index += 1) {
      const reservation = child.reserve("concurrency");
      reservation.release();
    }

    expect(budget.snapshot().used.concurrency).toBe(0);
  });
});
