import { ActivityPlugError } from "../errors/error.js";

export const BUDGET_DIMENSIONS = [
  "bytes",
  "reads",
  "nodes",
  "depth",
  "requests",
  "activeAllocations",
  "concurrency",
  "deadline",
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];
export type BudgetMode = "off" | "observe" | "enforce";
export type BudgetLimits = Partial<Readonly<Record<BudgetDimension, number>>>;
export type BudgetTelemetryResult = "charged" | "released" | "exhausted";

export interface BudgetTelemetryEvent {
  readonly operation: string;
  readonly dimension: BudgetDimension;
  readonly result: BudgetTelemetryResult;
  readonly amount: number;
  readonly used: number;
  readonly limit?: number;
}

export interface BudgetScopeOptions {
  readonly mode?: BudgetMode;
  readonly operation: string;
  readonly limits?: BudgetLimits;
  readonly telemetry?: (event: BudgetTelemetryEvent) => void;
  readonly telemetryError?: (cause: unknown, event: BudgetTelemetryEvent) => void;
  readonly abortController?: AbortController;
  readonly now?: () => number;
}

export interface BudgetReservation {
  readonly dimension: BudgetDimension;
  readonly amount: number;
  release(): void;
}

export interface BudgetDeadlineWatch {
  readonly signal?: AbortSignal;
  dispose(): void;
}

export interface BudgetSnapshot {
  readonly mode: BudgetMode;
  readonly operation: string;
  readonly used: Readonly<Record<BudgetDimension, number>>;
  readonly limits: BudgetLimits;
}

export class BudgetExhaustedError extends ActivityPlugError {
  public constructor(
    public readonly dimension: BudgetDimension,
    public readonly limit: number,
    public readonly used: number,
    public readonly requested: number,
    operation: string,
  ) {
    super("REQUEST_LIMIT_EXCEEDED", `Operation budget exhausted for ${dimension}.`, { operation });
  }
}

interface BudgetState {
  readonly mode: BudgetMode;
  readonly operation: string;
  readonly used: Record<BudgetDimension, number>;
  readonly telemetry?: (event: BudgetTelemetryEvent) => void;
  readonly telemetryError?: (cause: unknown, event: BudgetTelemetryEvent) => void;
  readonly abortController?: AbortController;
  readonly startedAt: number;
  readonly now: () => number;
  deadlineCarryover: number;
}

const ZERO_USAGE: Readonly<Record<BudgetDimension, number>> = Object.freeze({
  bytes: 0,
  reads: 0,
  nodes: 0,
  depth: 0,
  requests: 0,
  activeAllocations: 0,
  concurrency: 0,
  deadline: 0,
});

export class BudgetScope {
  #state: BudgetState;
  #limits: BudgetLimits;

  public constructor(options: BudgetScopeOptions) {
    validateOperation(options.operation);
    validateLimits(options.limits);
    const now = options.now ?? Date.now;
    this.#state = {
      mode: options.mode ?? "enforce",
      operation: options.operation,
      used: { ...ZERO_USAGE },
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
      ...(options.telemetryError === undefined ? {} : { telemetryError: options.telemetryError }),
      ...(options.abortController === undefined
        ? {}
        : { abortController: options.abortController }),
      startedAt: now(),
      now,
      deadlineCarryover: 0,
    };
    this.#limits = Object.freeze({ ...options.limits });
  }

  public get mode(): BudgetMode {
    return this.#state.mode;
  }

  public get operation(): string {
    return this.#state.operation;
  }

  public child(limits: BudgetLimits = {}): BudgetScope {
    validateLimits(limits);
    const childLimits: Partial<Record<BudgetDimension, number>> = { ...this.#limits };
    for (const dimension of BUDGET_DIMENSIONS) {
      const requested = limits[dimension];
      if (requested === undefined) continue;
      const parent = this.#limits[dimension];
      if (parent !== undefined && requested > parent) {
        throw new ActivityPlugError(
          "VALIDATION_FAILED",
          `Child budget cannot increase the ${dimension} limit.`,
          { operation: this.operation },
        );
      }
      childLimits[dimension] = requested;
    }
    const child = new BudgetScope({ mode: this.mode, operation: this.operation });
    child.#state = this.#state;
    child.#limits = Object.freeze(childLimits);
    return child;
  }

  public charge(dimension: BudgetDimension, amount = 1): void {
    validateAmount(amount);
    if (this.mode === "off" || amount === 0) return;
    this.#apply(dimension, amount, false);
  }

  public reserve(dimension: BudgetDimension, amount = 1): BudgetReservation {
    validateAmount(amount);
    if (this.mode !== "off" && amount !== 0) this.#apply(dimension, amount, false);
    let released = false;
    return {
      dimension,
      amount,
      release: () => {
        if (released) return;
        released = true;
        if (this.mode === "off" || amount === 0) return;
        this.#apply(dimension, amount, true);
      },
    };
  }

  public checkDeadline(): void {
    if (this.mode === "off") return;
    const elapsed =
      this.#state.deadlineCarryover + Math.max(0, this.#state.now() - this.#state.startedAt);
    const current = this.#state.used.deadline;
    if (elapsed <= current) return;
    this.#apply("deadline", elapsed - current, false);
  }

  public absorb(snapshot: BudgetSnapshot): void {
    for (const dimension of BUDGET_DIMENSIONS) validateAmount(snapshot.used[dimension]);
    if (snapshot.used.activeAllocations !== 0 || snapshot.used.concurrency !== 0) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "Completed operation budgets must not retain resource reservations.",
        { operation: this.operation },
      );
    }
    if (this.mode === "off") return;
    for (const dimension of ["bytes", "reads", "nodes", "depth", "requests"] as const) {
      this.charge(dimension, snapshot.used[dimension]);
    }
    const deadline = snapshot.used.deadline;
    if (deadline === 0) return;
    this.#state.deadlineCarryover += deadline;
    this.charge("deadline", deadline);
  }

  public watchDeadline(): BudgetDeadlineWatch {
    const limit = this.#limits.deadline;
    if (this.mode === "off" || limit === undefined) return { dispose() {} };

    const controller = this.mode === "enforce" ? new AbortController() : undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (disposed || controller?.signal.aborted === true) return;
      const elapsed =
        this.#state.deadlineCarryover + Math.max(0, this.#state.now() - this.#state.startedAt);
      const remaining = Math.max(0, limit - elapsed + 1);
      timer = setTimeout(
        () => {
          timer = undefined;
          try {
            this.checkDeadline();
          } catch (cause) {
            controller?.abort(cause);
            return;
          }
          if (this.#state.used.deadline <= limit) arm();
        },
        Math.min(remaining, 2_147_483_647),
      );
    };
    arm();
    return {
      ...(controller === undefined ? {} : { signal: controller.signal }),
      dispose() {
        if (disposed) return;
        disposed = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      },
    };
  }

  public snapshot(): BudgetSnapshot {
    return {
      mode: this.mode,
      operation: this.operation,
      used: Object.freeze({ ...this.#state.used }),
      limits: this.#limits,
    };
  }

  #apply(dimension: BudgetDimension, amount: number, release: boolean): void {
    const previous = this.#state.used[dimension];
    const used = release ? Math.max(0, previous - amount) : previous + amount;
    const limit = this.#limits[dimension];
    if (!release && limit !== undefined && used > limit) {
      this.#emit(dimension, "exhausted", amount, used, limit);
      if (this.mode === "enforce") {
        const error = new BudgetExhaustedError(dimension, limit, previous, amount, this.operation);
        this.#state.abortController?.abort(error);
        throw error;
      }
    }
    this.#state.used[dimension] = used;
    this.#emit(dimension, release ? "released" : "charged", amount, used, limit);
  }

  #emit(
    dimension: BudgetDimension,
    result: BudgetTelemetryResult,
    amount: number,
    used: number,
    limit: number | undefined,
  ): void {
    const event: BudgetTelemetryEvent = {
      operation: this.operation,
      dimension,
      result,
      amount,
      used,
      ...(limit === undefined ? {} : { limit }),
    };
    try {
      this.#state.telemetry?.(event);
    } catch (cause) {
      try {
        this.#state.telemetryError?.(cause, event);
      } catch {
        // Telemetry observers must not change operation behavior.
      }
    }
  }
}

function validateOperation(operation: string): void {
  if (operation.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Budget operation must not be empty.");
  }
}

function validateLimits(limits: BudgetLimits | undefined): void {
  if (limits === undefined) return;
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = limits[dimension];
    if (limit !== undefined) validateNonNegativeInteger(limit, `${dimension} limit`);
  }
}

function validateAmount(amount: number): void {
  validateNonNegativeInteger(amount, "Budget amount");
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `${label} must be a non-negative safe integer.`,
    );
  }
}
