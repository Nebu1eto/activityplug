import { ActivityPlugError } from "@activityplug/core";
import {
  Kind,
  Lexer,
  Source,
  TokenKind,
  parse,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "graphql";

const MAX_GRAPHQL_PARSE_TOKENS = 8_192;
const MAX_GRAPHQL_PARSE_NESTING = 128;

export interface GraphQLLimits {
  readonly aliases: number;
  readonly depth: number;
  readonly complexity: number;
  readonly outboundConcurrency: number;
}

export const DEFAULT_GRAPHQL_LIMITS: GraphQLLimits = Object.freeze({
  aliases: 20,
  depth: 12,
  complexity: 200,
  outboundConcurrency: 10,
});

export interface GraphQLAnalysisMetrics {
  readonly aliases: number;
  /** Root fields have depth one; fragments do not add depth by themselves. */
  readonly depth: number;
  /** Every statically selected field costs one, including repeated spreads. */
  readonly complexity: number;
}

export interface GraphQLAnalysisResult {
  readonly document: DocumentNode;
  readonly operation: OperationDefinitionNode;
  readonly metrics: GraphQLAnalysisMetrics;
}

export interface AnalyzeGraphQLOptions {
  readonly operationName?: string;
  readonly limits?: Partial<GraphQLLimits>;
}

interface SelectionFrame {
  readonly selectionSet: SelectionSetNode;
  readonly depth: number;
}

interface FragmentFrame {
  readonly name: string;
  index: number;
}

interface SemaphoreWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

export function resolveGraphQLLimits(overrides: Partial<GraphQLLimits> = {}): GraphQLLimits {
  if (typeof overrides !== "object" || overrides === null) {
    throw new TypeError("GraphQL limit overrides must be an object.");
  }
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_GRAPHQL_LIMITS, name)) {
      throw new TypeError(`Unknown GraphQL limit override: ${name}.`);
    }
  }
  const resolved: GraphQLLimits = {
    ...DEFAULT_GRAPHQL_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    assertPositiveSafeInteger(value, `GraphQL limit ${name}`);
  }
  if (resolved.depth > resolved.complexity) {
    throw new TypeError("GraphQL depth limit must not exceed the complexity limit.");
  }
  if (resolved.aliases > resolved.complexity) {
    throw new TypeError("GraphQL alias limit must not exceed the complexity limit.");
  }
  return Object.freeze(resolved);
}

export function parseAndAnalyzeGraphQL(
  source: string,
  options: AnalyzeGraphQLOptions = {},
): GraphQLAnalysisResult {
  if (typeof source !== "string") throw new TypeError("GraphQL source must be a string.");
  if (typeof options !== "object" || options === null) {
    throw new TypeError("GraphQL analysis options must be an object.");
  }
  if (options.operationName !== undefined && options.operationName.trim() === "") {
    throw validationError("GraphQL operation name must not be empty.");
  }

  // The returned document is the same AST analyzed below, so transport code
  // can validate and execute it without reparsing attacker-controlled input.
  assertGraphQLParserWork(source);
  const document = parse(source, { maxTokens: MAX_GRAPHQL_PARSE_TOKENS });
  const limits = resolveGraphQLLimits(options.limits);
  const operation = selectOperation(document, options.operationName);
  const fragments = collectFragments(document);
  const fragmentReferences = collectFragmentReferences(fragments);
  const rootReferences = directFragmentReferences(operation.selectionSet);
  validateReachableFragments(rootReferences, fragments, fragmentReferences);
  const metrics = analyzeSelectionSet(operation.selectionSet, fragments, limits);
  return Object.freeze({ document, operation, metrics });
}

export class FairSemaphore {
  readonly #maximum: number;
  readonly #queue: SemaphoreWaiter[] = [];
  #active = 0;

  public constructor(maximum: number) {
    assertPositiveSafeInteger(maximum, "Semaphore maximum");
    this.#maximum = maximum;
  }

  public get active(): number {
    return this.#active;
  }

  public get pending(): number {
    return this.#queue.length;
  }

  public acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#active < this.#maximum && this.#queue.length === 0) {
      this.#active += 1;
      return Promise.resolve(this.#createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  public async run<T>(work: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (typeof work !== "function") throw new TypeError("Semaphore work must be a function.");
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  #createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#maximum) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) return;
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted === true) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.#active += 1;
      waiter.resolve(this.#createRelease());
    }
  }
}

export function createOutboundSemaphore(
  limits: GraphQLLimits = DEFAULT_GRAPHQL_LIMITS,
): FairSemaphore {
  return new FairSemaphore(resolveGraphQLLimits(limits).outboundConcurrency);
}

function selectOperation(
  document: DocumentNode,
  operationName: string | undefined,
): OperationDefinitionNode {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operationName === undefined) {
    if (operations.length !== 1) {
      throw validationError("GraphQL operation selection is ambiguous.");
    }
    return operations[0];
  }

  const matches = operations.filter((operation) => operation.name?.value === operationName);
  if (matches.length !== 1) {
    throw validationError(`GraphQL operation ${operationName} was not uniquely defined.`);
  }
  return matches[0];
}

function collectFragments(document: DocumentNode): ReadonlyMap<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
    const name = definition.name.value;
    if (fragments.has(name)) {
      throw validationError(`GraphQL fragment ${name} was defined more than once.`);
    }
    fragments.set(name, definition);
  }
  return fragments;
}

function collectFragmentReferences(
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): ReadonlyMap<string, readonly string[]> {
  const references = new Map<string, readonly string[]>();
  for (const [name, fragment] of fragments) {
    references.set(name, directFragmentReferences(fragment.selectionSet));
  }
  return references;
}

function directFragmentReferences(selectionSet: SelectionSetNode): readonly string[] {
  const references: string[] = [];
  const stack: SelectionSetNode[] = [selectionSet];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const selection of current.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        references.push(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        stack.push(selection.selectionSet);
      } else if (selection.selectionSet !== undefined) {
        stack.push(selection.selectionSet);
      }
    }
  }
  return references;
}

function validateReachableFragments(
  roots: readonly string[],
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  references: ReadonlyMap<string, readonly string[]>,
): void {
  const state = new Map<string, "visiting" | "done">();
  for (const root of roots) {
    if (!fragments.has(root)) throw validationError(`GraphQL fragment ${root} is not defined.`);
    if (state.get(root) === "done") continue;
    const stack: FragmentFrame[] = [{ name: root, index: 0 }];
    state.set(root, "visiting");

    // An explicit stack prevents a deeply nested fragment graph from turning
    // cycle detection itself into a recursive denial of service.
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const children = references.get(frame.name) ?? [];
      if (frame.index >= children.length) {
        state.set(frame.name, "done");
        stack.pop();
        continue;
      }
      const child = children[frame.index++];
      if (!fragments.has(child)) {
        throw validationError(`GraphQL fragment ${child} is not defined.`);
      }
      const childState = state.get(child);
      if (childState === "visiting") {
        throw validationError(`GraphQL fragment cycle includes ${child}.`);
      }
      if (childState === "done") continue;
      state.set(child, "visiting");
      stack.push({ name: child, index: 0 });
    }
  }
}

function analyzeSelectionSet(
  root: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  limits: GraphQLLimits,
): GraphQLAnalysisMetrics {
  let aliases = 0;
  let depth = 0;
  let complexity = 0;
  const stack: SelectionFrame[] = [{ selectionSet: root, depth: 1 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const selection of frame.selectionSet.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        stack.push({
          selectionSet: fragments.get(selection.name.value)!.selectionSet,
          depth: frame.depth,
        });
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        stack.push({ selectionSet: selection.selectionSet, depth: frame.depth });
        continue;
      }

      complexity += 1;
      if (selection.alias !== undefined) aliases += 1;
      depth = Math.max(depth, frame.depth);
      if (aliases > limits.aliases) throw graphQLLimitError("alias", limits.aliases, aliases);
      if (depth > limits.depth) throw graphQLLimitError("depth", limits.depth, depth);
      if (complexity > limits.complexity) {
        throw graphQLLimitError("complexity", limits.complexity, complexity);
      }
      if (selection.selectionSet !== undefined) {
        stack.push({ selectionSet: selection.selectionSet, depth: frame.depth + 1 });
      }
    }
  }

  return Object.freeze({ aliases, depth, complexity });
}

function assertGraphQLParserWork(source: string): void {
  const lexer = new Lexer(new Source(source));
  let tokens = 0;
  let nesting = 0;

  for (;;) {
    const token = lexer.advance();
    if (token.kind === TokenKind.EOF) return;

    tokens += 1;
    if (tokens > MAX_GRAPHQL_PARSE_TOKENS) {
      throw graphQLLimitError("tokens", MAX_GRAPHQL_PARSE_TOKENS, tokens);
    }

    if (
      token.kind === TokenKind.BRACE_L ||
      token.kind === TokenKind.BRACKET_L ||
      token.kind === TokenKind.PAREN_L
    ) {
      nesting += 1;
      if (nesting > MAX_GRAPHQL_PARSE_NESTING) {
        throw graphQLLimitError("parserNesting", MAX_GRAPHQL_PARSE_NESTING, nesting);
      }
    } else if (
      token.kind === TokenKind.BRACE_R ||
      token.kind === TokenKind.BRACKET_R ||
      token.kind === TokenKind.PAREN_R
    ) {
      nesting = Math.max(0, nesting - 1);
    }
  }
}

function graphQLLimitError(metric: string, limit: number, actual: number): ActivityPlugError {
  const label = metric === "parserNesting" ? "parser nesting" : metric;
  return new ActivityPlugError(
    "REQUEST_LIMIT_EXCEEDED",
    `GraphQL request exceeded the configured ${label} limit.`,
    { operation: "graphql.analyze", raw: { metric, limit, actual } },
  );
}

function validationError(message: string): ActivityPlugError {
  return new ActivityPlugError("VALIDATION_FAILED", message, {
    operation: "graphql.analyze",
  });
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}
