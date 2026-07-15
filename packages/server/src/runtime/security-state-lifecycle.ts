import { type SecurityStateExpiryMetadata } from "../storage/contracts.js";

export interface SecurityStateCapacityMetadata {
  readonly maximumEntries?: number;
}

export interface SecurityStateCleanupResult {
  readonly kind: string;
  readonly deleted: number;
  readonly checkedAt: Date;
}

export interface SecurityStateLifecycleMetrics {
  readonly cleanupCompleted?: (result: SecurityStateCleanupResult) => void;
  readonly cleanupFailed?: (kind: string, error: unknown) => void;
}

interface SecurityStateDescriptorBase {
  readonly kind: string;
  readonly capacity?: SecurityStateCapacityMetadata;
  readonly metrics?: SecurityStateLifecycleMetrics;
}

export interface NativeExpirySecurityStateDescriptor extends SecurityStateDescriptorBase {
  readonly expiryMode: "native";
}

export interface SweepExpirySecurityStateDescriptor extends SecurityStateDescriptorBase {
  readonly expiryMode: "sweep";
  readonly batchSize: number;
  readonly intervalMilliseconds: number;
  readonly cleanupGraceMilliseconds: number;
  readonly cleanup: (input: {
    readonly checkedAt: Date;
    readonly batchSize: number;
    readonly cleanupGraceMilliseconds: number;
  }) => Promise<number>;
}

export type SecurityStateDescriptor =
  | NativeExpirySecurityStateDescriptor
  | SweepExpirySecurityStateDescriptor;

export interface SecurityStateLifecycleTimer {
  readonly unref?: () => void;
}

export interface SecurityStateLifecycleScheduler {
  readonly setInterval: (
    callback: () => void,
    intervalMilliseconds: number,
  ) => SecurityStateLifecycleTimer;
  readonly clearInterval: (timer: SecurityStateLifecycleTimer) => void;
}

export interface SecurityStateLifecycleOptions {
  readonly now?: () => Date;
  readonly scheduler?: SecurityStateLifecycleScheduler;
}

export function createSweepSecurityStateDescriptor(
  kind: string,
  cleanup: (now: Date, limit: number) => Promise<number>,
): SweepExpirySecurityStateDescriptor {
  return {
    kind,
    expiryMode: "sweep",
    batchSize: 500,
    intervalMilliseconds: 60_000,
    cleanupGraceMilliseconds: 0,
    cleanup: ({ checkedAt, batchSize }) => cleanup(checkedAt, batchSize),
  };
}

export function createSecurityStateDescriptor(
  kind: string,
  store: SecurityStateExpiryMetadata,
  cleanup: (now: Date, limit: number) => Promise<number>,
): SecurityStateDescriptor {
  return store.expiryMode === "native"
    ? { kind, expiryMode: "native" }
    : createSweepSecurityStateDescriptor(kind, cleanup);
}

interface SweepWorker {
  readonly descriptor: SweepExpirySecurityStateDescriptor;
  timer: SecurityStateLifecycleTimer | null;
  inFlight: Promise<void> | null;
}

const defaultScheduler: SecurityStateLifecycleScheduler = {
  setInterval(callback, intervalMilliseconds) {
    return setInterval(callback, intervalMilliseconds);
  },
  clearInterval(timer) {
    clearInterval(timer as ReturnType<typeof setInterval>);
  },
};

export class SecurityStateLifecycle implements AsyncDisposable {
  readonly #now: () => Date;
  readonly #scheduler: SecurityStateLifecycleScheduler;
  readonly #workers: readonly SweepWorker[];
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;

  public constructor(
    descriptors: readonly SecurityStateDescriptor[],
    options: SecurityStateLifecycleOptions = {},
  ) {
    validateDescriptors(descriptors);
    this.#now = options.now ?? (() => new Date());
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#workers = descriptors
      .filter(
        (descriptor): descriptor is SweepExpirySecurityStateDescriptor =>
          descriptor.expiryMode === "sweep",
      )
      .map((descriptor) => ({ descriptor, timer: null, inFlight: null }));
  }

  public start(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("Security state lifecycle is closed."));
    }
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #start(): Promise<void> {
    await Promise.all(this.#workers.map((worker) => this.#run(worker, true)));
    if (this.#closed) return;
    for (const worker of this.#workers) {
      if (worker.timer !== null) continue;
      const timer = this.#scheduler.setInterval(() => {
        void this.#run(worker);
      }, worker.descriptor.intervalMilliseconds);
      timer.unref?.();
      worker.timer = timer;
    }
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const worker of this.#workers) {
      if (worker.timer === null) continue;
      this.#scheduler.clearInterval(worker.timer);
      worker.timer = null;
    }
    await Promise.all(this.#workers.map(async (worker) => worker.inFlight));
  }

  #run(worker: SweepWorker, rejectOnFailure = false): Promise<void> {
    if (this.#closed || worker.inFlight !== null) return Promise.resolve();
    const checkedAt = this.#now();
    const task = Promise.resolve()
      .then(() =>
        worker.descriptor.cleanup({
          checkedAt,
          batchSize: worker.descriptor.batchSize,
          cleanupGraceMilliseconds: worker.descriptor.cleanupGraceMilliseconds,
        }),
      )
      .then((deleted) => {
        safelyInvokeMetric(() =>
          worker.descriptor.metrics?.cleanupCompleted?.({
            kind: worker.descriptor.kind,
            deleted,
            checkedAt,
          }),
        );
      })
      .catch((error: unknown) => {
        safelyInvokeMetric(() =>
          worker.descriptor.metrics?.cleanupFailed?.(worker.descriptor.kind, error),
        );
        if (rejectOnFailure) throw error;
      })
      .finally(() => {
        worker.inFlight = null;
      });
    worker.inFlight = task;
    return task;
  }
}

function safelyInvokeMetric(callback: () => unknown): void {
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // Metrics are observational and must not alter security-state cleanup.
  }
}

function validateDescriptors(descriptors: readonly SecurityStateDescriptor[]): void {
  const kinds = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.kind.length === 0) {
      throw new TypeError("Security state kind must not be empty.");
    }
    if (kinds.has(descriptor.kind)) {
      throw new TypeError(`Security state kind is registered more than once: ${descriptor.kind}`);
    }
    kinds.add(descriptor.kind);
    if (descriptor.expiryMode === "native") continue;
    assertPositiveInteger(descriptor.batchSize, "batchSize");
    assertPositiveInteger(descriptor.intervalMilliseconds, "intervalMilliseconds");
    assertNonNegativeInteger(descriptor.cleanupGraceMilliseconds, "cleanupGraceMilliseconds");
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}
