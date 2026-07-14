import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRAPHQL_LIMITS,
  FairSemaphore,
  parseAndAnalyzeGraphQL,
  resolveGraphQLLimits,
} from "./graphql-limits.js";

function fields(count: number, aliased = false): string {
  return Array.from({ length: count }, (_, index) =>
    aliased ? `alias${index}: field${index}` : `field${index}`,
  ).join(" ");
}

function nestedQuery(depth: number): string {
  if (depth === 1) return "query { leaf }";
  return `query { ${"node { ".repeat(depth - 1)}leaf ${"}".repeat(depth - 1)} }`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GraphQL limit configuration", () => {
  it("uses exact immutable defaults and resolves immutable overrides", () => {
    expect(DEFAULT_GRAPHQL_LIMITS).toEqual({
      aliases: 20,
      depth: 12,
      complexity: 200,
      outboundConcurrency: 10,
    });
    expect(Object.isFrozen(DEFAULT_GRAPHQL_LIMITS)).toBe(true);
    const resolved = resolveGraphQLLimits({ complexity: 300 });
    expect(resolved).toEqual({ ...DEFAULT_GRAPHQL_LIMITS, complexity: 300 });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects unsafe GraphQL limit %s",
    (value) => {
      expect(() => resolveGraphQLLimits({ depth: value })).toThrow(TypeError);
    },
  );

  it("rejects limits whose depth can never fit within complexity", () => {
    expect(() => resolveGraphQLLimits({ depth: 4, complexity: 3 })).toThrow(/depth/u);
  });

  it("rejects unknown override keys instead of retaining them", () => {
    expect(() =>
      resolveGraphQLLimits({ alias: 1 } as unknown as Partial<typeof DEFAULT_GRAPHQL_LIMITS>),
    ).toThrow(/alias/u);
  });
});

describe("GraphQL document analysis", () => {
  it("rejects hostile parser nesting before recursive parsing exhausts the stack", () => {
    expect(() => parseAndAnalyzeGraphQL(nestedQuery(129))).toThrowError(
      expect.objectContaining({
        code: "REQUEST_LIMIT_EXCEEDED",
        context: {
          operation: "graphql.analyze",
          raw: { actual: 129, limit: 128, metric: "parserNesting" },
        },
      }),
    );
  });

  it("rejects excessive parser tokens before building an unbounded AST", () => {
    expect(() => parseAndAnalyzeGraphQL(`query { ${fields(8_190)} }`)).toThrowError(
      expect.objectContaining({
        code: "REQUEST_LIMIT_EXCEEDED",
        context: {
          operation: "graphql.analyze",
          raw: { actual: 8_193, limit: 8_192, metric: "tokens" },
        },
      }),
    );
  });

  it("accepts complexity 200 and rejects 201", () => {
    expect(parseAndAnalyzeGraphQL(`query { ${fields(200)} }`).metrics.complexity).toBe(200);
    expect(() => parseAndAnalyzeGraphQL(`query { ${fields(201)} }`)).toThrowError(
      expect.objectContaining({
        code: "REQUEST_LIMIT_EXCEEDED",
        message: "GraphQL request exceeded the configured complexity limit.",
      }),
    );
  });

  it("analyzes only the selected operation and its used fragments", () => {
    const source = `
      query Small { one }
      query Large { ...LargeFields }
      fragment LargeFields on Query { ${fields(201)} }
      fragment UnusedCycle on Query { ...UnusedCycle }
      fragment UnusedUnknown on Query { ...Missing }
    `;

    expect(parseAndAnalyzeGraphQL(source, { operationName: "Small" }).metrics).toEqual({
      aliases: 0,
      depth: 1,
      complexity: 1,
    });
    expect(() => parseAndAnalyzeGraphQL(source, { operationName: "Large" })).toThrowError(
      expect.objectContaining({ code: "REQUEST_LIMIT_EXCEEDED" }),
    );
  });

  it("detects reachable fragment cycles and unknown fragments", () => {
    expect(() =>
      parseAndAnalyzeGraphQL(`
        query { ...A }
        fragment A on Query { ...B }
        fragment B on Query { ...A }
      `),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseAndAnalyzeGraphQL("query { ...Missing }")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects ambiguous or missing operation selection", () => {
    const source = "query First { one } query Second { two }";

    expect(() => parseAndAnalyzeGraphQL(source)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() => parseAndAnalyzeGraphQL(source, { operationName: "Missing" })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(parseAndAnalyzeGraphQL(source, { operationName: "Second" }).operation.name?.value).toBe(
      "Second",
    );
  });
});

describe("FairSemaphore", () => {
  it("never exceeds its concurrency and admits queued work in FIFO order", async () => {
    const semaphore = new FairSemaphore(2);
    const firstGate = deferred();
    const secondGate = deferred();
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const work = async (id: number, gate?: Promise<void>) => {
      await semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(id);
        if (gate !== undefined) await gate;
        active -= 1;
      });
    };

    const tasks = [work(1, firstGate.promise), work(2, secondGate.promise), work(3), work(4)];
    await Promise.resolve();
    expect(order).toEqual([1, 2]);

    secondGate.resolve();
    await Promise.all(tasks.slice(1));
    expect(order).toEqual([1, 2, 3, 4]);
    firstGate.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(semaphore.active).toBe(0);
    expect(semaphore.pending).toBe(0);
  });

  it("removes aborted waiters without leaking a permit", async () => {
    const semaphore = new FairSemaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const reason = new Error("cancelled queue entry");
    const aborted = semaphore.acquire(controller.signal);
    const next = semaphore.acquire();

    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    expect(semaphore.pending).toBe(1);

    release();
    const releaseNext = await next;
    expect(semaphore.active).toBe(1);
    releaseNext();
    releaseNext();
    expect(semaphore.active).toBe(0);
  });

  it("releases a permit when guarded work rejects", async () => {
    const semaphore = new FairSemaphore(1);

    await expect(
      semaphore.run(() => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    const release = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    release();
  });
});
