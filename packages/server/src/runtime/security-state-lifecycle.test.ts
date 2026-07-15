import { describe, expect, it, vi } from "vitest";

import {
  SecurityStateLifecycle,
  type SecurityStateLifecycleScheduler,
  type SecurityStateLifecycleTimer,
  type SweepExpirySecurityStateDescriptor,
} from "./security-state-lifecycle.js";

describe("SecurityStateLifecycle", () => {
  it("runs traffic-free startup cleanup and passes bounded metadata", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    const cleanup = vi.fn(async () => 3);
    const lifecycle = new SecurityStateLifecycle(
      [sweepDescriptor("callback", cleanup)],
      clock.options,
    );

    await lifecycle.start();

    expect(cleanup).toHaveBeenCalledExactlyOnceWith({
      checkedAt: new Date("2026-07-15T00:00:00.000Z"),
      batchSize: 25,
      cleanupGraceMilliseconds: 5_000,
    });
    expect(clock.activeTimerCount).toBe(1);
    expect(clock.unrefCount).toBe(1);
    await lifecycle.close();
  });

  it("does not schedule workers for native expiry", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    const lifecycle = new SecurityStateLifecycle(
      [{ kind: "redis-ticket", expiryMode: "native", capacity: { maximumEntries: 100 } }],
      clock.options,
    );

    await lifecycle.start();

    expect(clock.activeTimerCount).toBe(0);
    await lifecycle.close();
  });

  it("never overlaps cleanup for the same descriptor", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    let finish: (() => void) | undefined;
    const cleanup = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            finish = () => resolve(0);
          }),
      );
    const lifecycle = new SecurityStateLifecycle(
      [sweepDescriptor("browser-state", cleanup)],
      clock.options,
    );
    await lifecycle.start();
    clock.tick();
    await waitForCalls(cleanup, 2);
    clock.tick();

    expect(cleanup).toHaveBeenCalledTimes(2);
    finish?.();
    await lifecycle.close();
  });

  it("reports startup cleanup failures and rejects without scheduling workers", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    const error = new Error("store unavailable");
    const failed = vi.fn().mockRejectedValue(error);
    const healthy = vi.fn(async () => 2);
    const onFailure = vi.fn();
    const lifecycle = new SecurityStateLifecycle(
      [
        sweepDescriptor("failed", failed, { cleanupFailed: onFailure }),
        sweepDescriptor("healthy", healthy),
      ],
      clock.options,
    );

    await expect(lifecycle.start()).rejects.toBe(error);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("failed", error);
    expect(clock.activeTimerCount).toBe(0);
    await lifecycle.close();
  });

  it("isolates periodic failures and retries on the next tick", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    const error = new Error("store unavailable");
    const failed = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(error)
      .mockResolvedValue(1);
    const healthy = vi.fn(async () => 2);
    const onFailure = vi.fn();
    const lifecycle = new SecurityStateLifecycle(
      [
        sweepDescriptor("failed", failed, { cleanupFailed: onFailure }),
        sweepDescriptor("healthy", healthy),
      ],
      clock.options,
    );

    await lifecycle.start();

    clock.advance(60_000);
    await waitForCalls(failed, 2);
    await waitForCalls(healthy, 2);
    expect(onFailure).toHaveBeenCalledWith("failed", error);

    clock.advance(60_000);
    await waitForCalls(failed, 3);
    await waitForCalls(healthy, 3);
    expect(failed).toHaveBeenCalledTimes(3);
    expect(healthy).toHaveBeenCalledTimes(3);
    await lifecycle.close();
  });

  it("does not let completion metrics change successful cleanup", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    const cleanup = vi.fn(async () => 1);
    const lifecycle = new SecurityStateLifecycle(
      [
        sweepDescriptor("browser-state", cleanup, {
          cleanupCompleted: async () => {
            throw new Error("metrics unavailable");
          },
        }),
      ],
      clock.options,
    );

    await expect(lifecycle.start()).resolves.toBeUndefined();
    clock.advance(60_000);
    await waitForCalls(cleanup, 2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    await lifecycle.close();
  });

  it("preserves the cleanup error when failure metrics throw", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    const cleanupError = new Error("store unavailable");
    const lifecycle = new SecurityStateLifecycle(
      [
        sweepDescriptor("browser-state", vi.fn().mockRejectedValue(cleanupError), {
          cleanupFailed: async () => {
            throw new Error("metrics unavailable");
          },
        }),
      ],
      clock.options,
    );

    await expect(lifecycle.start()).rejects.toBe(cleanupError);
    expect(clock.activeTimerCount).toBe(0);
    await lifecycle.close();
  });

  it("drains startup cleanup when close races with start and never schedules a timer", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    let finish: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(0);
        }),
    );
    const lifecycle = new SecurityStateLifecycle(
      [sweepDescriptor("runtime-secret", cleanup)],
      clock.options,
    );

    const start = lifecycle.start();
    await waitForCalls(cleanup, 1);
    const close = lifecycle.close();
    finish?.();

    await expect(Promise.all([start, close])).resolves.toEqual([undefined, undefined]);
    expect(clock.activeTimerCount).toBe(0);
    clock.advance(300_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("drains once, closes idempotently, and never invokes cleanup after close", async () => {
    const clock = new FakeClock("2026-07-15T00:00:00.000Z");
    const cleanup = vi.fn(async () => 0);
    const lifecycle = new SecurityStateLifecycle(
      [sweepDescriptor("runtime-secret", cleanup)],
      clock.options,
    );
    await lifecycle.start();

    const first = lifecycle.close();
    const second = lifecycle.close();
    expect(second).toBe(first);
    await first;
    clock.advance(300_000);

    expect(clock.activeTimerCount).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await lifecycle[Symbol.asyncDispose]();
  });
});

function sweepDescriptor(
  kind: string,
  cleanup: SweepExpirySecurityStateDescriptor["cleanup"],
  metrics?: SweepExpirySecurityStateDescriptor["metrics"],
): SweepExpirySecurityStateDescriptor {
  return {
    kind,
    expiryMode: "sweep",
    batchSize: 25,
    intervalMilliseconds: 60_000,
    cleanupGraceMilliseconds: 5_000,
    capacity: { maximumEntries: 1_000 },
    cleanup,
    metrics,
  };
}

class FakeClock {
  readonly #timers = new Set<FakeTimer>();
  #now: Date;
  unrefCount = 0;

  public constructor(now: string) {
    this.#now = new Date(now);
  }

  public readonly options = {
    now: (): Date => new Date(this.#now),
    scheduler: {
      setInterval: (callback: () => void, intervalMilliseconds: number): FakeTimer => {
        const timer = new FakeTimer(callback, intervalMilliseconds, () => {
          this.unrefCount += 1;
        });
        this.#timers.add(timer);
        return timer;
      },
      clearInterval: (timer: SecurityStateLifecycleTimer): void => {
        const fakeTimer = timer as FakeTimer;
        fakeTimer.active = false;
        this.#timers.delete(fakeTimer);
      },
    } satisfies SecurityStateLifecycleScheduler,
  };

  public get activeTimerCount(): number {
    return this.#timers.size;
  }

  public tick(): void {
    for (const timer of this.#timers) timer.callback();
  }

  public advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds);
    for (const timer of this.#timers) {
      if (timer.active && milliseconds >= timer.intervalMilliseconds) timer.callback();
    }
  }
}

class FakeTimer implements SecurityStateLifecycleTimer {
  active = true;

  public constructor(
    public readonly callback: () => void,
    public readonly intervalMilliseconds: number,
    private readonly onUnref: () => void,
  ) {}

  public unref(): void {
    this.onUnref();
  }
}

async function waitForCalls(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
}
