import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";

import { streamWebSocketMessages } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type NodeWebSocket from "ws";

import {
  createNodePinnedWebSocketFactory,
  createNodePinnedWebSocketFactoryWithConstructor,
  DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS,
  DEFAULT_WEBSOCKET_MAX_BUFFERED_CHUNKS,
  DEFAULT_WEBSOCKET_MAX_FRAGMENTS,
  DEFAULT_WEBSOCKET_MAX_PAYLOAD,
} from "./node-websocket-egress.js";

describe("createNodePinnedWebSocketFactory", () => {
  it("uses the vetted address as the only DNS result for the handshake", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const assertAllowed = vi.fn(async () => undefined);
    const instances: CapturingWebSocket[] = [];
    const factory = createNodePinnedWebSocketFactoryWithConstructor(
      {
        lookup,
        originPolicy: { assertAllowed },
      },
      class extends CapturingWebSocket {
        public constructor(url: string, _protocols?: string | string[], options?: CapturedOptions) {
          super(url, options as CapturedOptions);
          instances.push(this);
        }
      } as unknown as Parameters<typeof createNodePinnedWebSocketFactoryWithConstructor>[1],
    );

    const connecting = factory(
      "wss://social.example:8443/streaming?i=token-must-not-log",
      undefined,
      undefined,
      { operation: "media.ingestUrl", authorization: "Bearer header-secret" },
    );
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    const socket = instances[0];
    const resolved = await socket.lookupAddress();
    socket.open();

    await expect(connecting).resolves.toBe(socket);
    expect(lookup).toHaveBeenCalledOnce();
    expect(assertAllowed).toHaveBeenCalledWith(
      "https://social.example:8443",
      "media.ingestUrl",
      expect.any(AbortSignal),
    );
    expect(resolved).toEqual({ address: "8.8.8.8", family: 4 });
    expect(socket.options).toMatchObject({
      autoSelectFamily: false,
      servername: "social.example",
      headers: {
        host: "social.example:8443",
        authorization: "Bearer header-secret",
      },
      closeTimeout: DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS,
      maxBufferedChunks: DEFAULT_WEBSOCKET_MAX_BUFFERED_CHUNKS,
      maxFragments: DEFAULT_WEBSOCKET_MAX_FRAGMENTS,
      maxPayload: DEFAULT_WEBSOCKET_MAX_PAYLOAD,
      perMessageDeflate: false,
    });
    expect(socket.url).not.toContain("header-secret");
  });

  it("completes a real Node handshake through the scalar pinned lookup", async () => {
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the WebSocket test server to expose a TCP port.");
    }
    let socket: WebSocket | undefined;
    try {
      const factory = createNodePinnedWebSocketFactory({
        allowPrivateNetworks: true,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      });

      socket = await factory(`ws://social.example:${address.port}/streaming`);
      if (socket.readyState === 0) await once(socket, "open");

      expect(socket.readyState).toBe(1);
    } finally {
      if (socket?.readyState === 1) {
        const closed = new Promise<void>((resolve) =>
          socket?.addEventListener("close", () => resolve(), { once: true }),
        );
        socket.close();
        await closed;
      }
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("observes a first frame delivered with the raw upgrade response", async () => {
    const firstMessage = { type: "ready", sequence: 1 };
    const rawServer = await createRawWebSocketServer(({ response, socket }) => {
      socket.write(
        Buffer.concat([
          response,
          encodeServerFrame(0x01, JSON.stringify(firstMessage)),
          encodeServerFrame(0x08),
        ]),
      );
    });
    let socket: WebSocket | undefined;
    try {
      const factory = createNodePinnedWebSocketFactory({
        allowPrivateNetworks: true,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      });

      socket = await factory(`ws://social.example:${rawServer.port}/streaming`);
      expect(socket.readyState).toBe(0);
      const messages = streamWebSocketMessages({
        socket,
        networkErrorMessage: "Remote stream failed.",
        invalidJsonMessage: "Remote stream returned invalid JSON.",
      });

      await expect(messages.next()).resolves.toEqual({ done: false, value: firstMessage });
      await expect(messages.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      if (socket?.readyState === 0 || socket?.readyState === 1) socket.close();
      await closeRawWebSocketServer(rawServer);
    }
  });

  it("rejects a private resolved address before socket construction without exposing a token", async () => {
    const construct = vi.fn();
    const factory = createNodePinnedWebSocketFactoryWithConstructor(
      {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      },
      construct,
    );

    const error = await Promise.resolve(
      factory("wss://social.example/streaming?i=secret-token"),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.connect", origin: "wss://social.example" },
    });
    expect(String(error)).not.toContain("secret-token");
    expect(construct).not.toHaveBeenCalled();
  });

  it("stops target resolution when the caller aborts", async () => {
    const controller = new AbortController();
    const factory = createNodePinnedWebSocketFactory({
      lookup: async (_hostname, signal) =>
        new Promise<readonly { readonly address: string; readonly family: 4 }[]>(
          (_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          },
        ),
      originPolicy: { assertAllowed: async () => undefined },
    });
    const reason = new Error("caller aborted");
    const connecting = factory("wss://social.example/streaming", undefined, controller.signal);

    controller.abort(reason);

    await expect(connecting).rejects.toBe(reason);
  });

  it("aborts a hanging real handshake without leaking the transport", async () => {
    const acceptedSockets = new Set<Socket>();
    const tcpServer = createTcpServer((socket) => {
      acceptedSockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => acceptedSockets.delete(socket));
      // Drain the HTTP upgrade request so the peer's FIN/RST is observable.
      socket.resume();
    });
    tcpServer.listen(0, "127.0.0.1");
    await once(tcpServer, "listening");
    const address = tcpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the TCP test server to expose a port.");
    }
    const controller = new AbortController();
    try {
      const accepted = once(tcpServer, "connection");
      const factory = createNodePinnedWebSocketFactory({
        allowPrivateNetworks: true,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      });
      const socket = await factory(
        `ws://social.example:${address.port}/streaming`,
        undefined,
        controller.signal,
      );
      const messages = streamWebSocketMessages({
        socket,
        signal: controller.signal,
        networkErrorMessage: "Remote stream failed.",
        invalidJsonMessage: "Remote stream returned invalid JSON.",
      });
      const nextMessage = messages.next();

      await accepted;
      const reason = new Error("caller aborted pending handshake");
      controller.abort(reason);

      await expect(nextMessage).resolves.toEqual({ done: true, value: undefined });
      await vi.waitFor(() => expect(acceptedSockets.size).toBe(0));
      // ws reports an aborted CONNECTING socket asynchronously. Let that
      // terminal event run so Vitest catches any uncaught late error.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      controller.abort();
      for (const socket of acceptedSockets) socket.destroy();
      await closeTcpServer(tcpServer);
    }
  });

  it("keeps an error sink during the promise-to-consumer handoff", async () => {
    const instances: CapturingWebSocket[] = [];
    const factory = createNodePinnedWebSocketFactoryWithConstructor(
      {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      },
      class extends CapturingWebSocket {
        public constructor(url: string, _protocols?: string | string[], options?: CapturedOptions) {
          super(url, options as CapturedOptions);
          instances.push(this);
        }
      } as unknown as Parameters<typeof createNodePinnedWebSocketFactoryWithConstructor>[1],
    );
    const connecting = factory("wss://social.example/streaming");
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    const socket = instances[0];

    const nextTickError = socket.openThenFailOnNextTick(
      new Error("transport failed during handoff"),
    );

    await expect(connecting).resolves.toBe(socket);
    await expect(nextTickError).resolves.toBeUndefined();
    expect(socket.nodeLikeErrorsConsumed).toBe(1);
  });

  it("maps a real oversized WebSocket frame to the streaming limit error", async () => {
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the WebSocket test server to expose a TCP port.");
    }
    let socket: WebSocket | undefined;
    try {
      const connected = once(webSocketServer, "connection") as Promise<[NodeWebSocket]>;
      const factory = createNodePinnedWebSocketFactory({
        allowPrivateNetworks: true,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      });
      socket = await factory(`ws://social.example:${address.port}/streaming`);
      const [remoteSocket] = await connected;
      remoteSocket.on("error", () => undefined);

      const messages = streamWebSocketMessages({
        socket,
        networkErrorMessage: "Remote stream failed.",
        invalidJsonMessage: "Remote stream returned invalid JSON.",
      });
      const nextMessage = messages.next();
      const closed = new Promise<void>((resolve) =>
        socket?.addEventListener("close", () => resolve(), { once: true }),
      );

      remoteSocket.send(Buffer.alloc(DEFAULT_WEBSOCKET_MAX_PAYLOAD + 1));

      await expect(nextMessage).rejects.toMatchObject({
        code: "REQUEST_LIMIT_EXCEEDED",
        context: {
          operation: "stream.buffer",
          raw: { maxQueuedBytes: DEFAULT_WEBSOCKET_MAX_PAYLOAD },
        },
      });
      await closed;
    } finally {
      if (socket?.readyState === 0 || socket?.readyState === 1) socket.close();
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("maps too many real message fragments to the streaming limit error", async () => {
    const fragmentedMessage = Array.from(
      { length: DEFAULT_WEBSOCKET_MAX_FRAGMENTS + 1 },
      (_, index) => encodeServerFrame(index === 0 ? 0x01 : 0x00, "x", false),
    );
    const rawServer = await createRawWebSocketServer(({ response, socket }) => {
      socket.write(Buffer.concat([response, ...fragmentedMessage]));
    });
    let socket: WebSocket | undefined;
    let transportErrorCode: unknown;
    try {
      const factory = createNodePinnedWebSocketFactory({
        allowPrivateNetworks: true,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      });
      socket = await factory(`ws://social.example:${rawServer.port}/streaming`);
      const messages = streamWebSocketMessages({
        socket,
        networkErrorMessage: "Remote stream failed.",
        invalidJsonMessage: "Remote stream returned invalid JSON.",
      });
      socket.addEventListener("error", (event) => {
        transportErrorCode = webSocketTransportErrorCode(event);
      });

      await expect(messages.next()).rejects.toMatchObject({
        code: "REQUEST_LIMIT_EXCEEDED",
        context: {
          operation: "stream.buffer",
          raw: {
            maxQueuedBytes: DEFAULT_WEBSOCKET_MAX_PAYLOAD,
          },
        },
      });
      expect(transportErrorCode).toBe("WS_ERR_TOO_MANY_BUFFERED_PARTS");
    } finally {
      if (socket?.readyState === 0 || socket?.readyState === 1) socket.close();
      await closeRawWebSocketServer(rawServer);
    }
  });

  it("forces a real peer closed when it ignores the close handshake", async () => {
    const firstMessage = { type: "ready" };
    let resolveClientCloseFrame!: () => void;
    const clientCloseFrame = new Promise<void>((resolve) => {
      resolveClientCloseFrame = resolve;
    });
    const rawServer = await createRawWebSocketServer(
      ({ response, socket }) => {
        socket.write(
          Buffer.concat([response, encodeServerFrame(0x01, JSON.stringify(firstMessage))]),
        );
      },
      (data) => {
        if (data.length > 0 && (data[0] & 0x0f) === 0x08) resolveClientCloseFrame();
      },
    );
    let socket: WebSocket | undefined;
    try {
      const factory = createNodePinnedWebSocketFactory({
        allowPrivateNetworks: true,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      });
      socket = await factory(`ws://social.example:${rawServer.port}/streaming`);
      const messages = streamWebSocketMessages({
        socket,
        networkErrorMessage: "Remote stream failed.",
        invalidJsonMessage: "Remote stream returned invalid JSON.",
      });
      await expect(messages.next()).resolves.toEqual({ done: false, value: firstMessage });
      const [peerSocket] = [...rawServer.sockets];
      if (peerSocket === undefined) throw new Error("Expected an upgraded raw WebSocket peer.");
      const peerDisconnected = once(peerSocket, "close");
      const clientDisconnected = once(socket, "close");

      const closeStartedAt = performance.now();
      await messages.return(undefined);
      await expect(
        resolveWithin(clientCloseFrame, 500, "The client did not send a WebSocket close frame."),
      ).resolves.toBeUndefined();
      await expect(
        resolveWithin(
          Promise.all([peerDisconnected, clientDisconnected]),
          DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS + 500,
          "The ignored close handshake exceeded the configured timeout.",
        ),
      ).resolves.toHaveLength(2);

      expect(performance.now() - closeStartedAt).toBeLessThan(
        DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS + 500,
      );
      expect(socket.readyState).toBe(3);
    } finally {
      if (socket?.readyState === 0 || socket?.readyState === 1) socket.close();
      await closeRawWebSocketServer(rawServer);
    }
  });

  it("does not retain a credential-bearing transport error", async () => {
    const instances: CapturingWebSocket[] = [];
    const factory = createNodePinnedWebSocketFactoryWithConstructor(
      {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        originPolicy: { assertAllowed: async () => undefined },
      },
      class extends CapturingWebSocket {
        public constructor(url: string, _protocols?: string | string[], options?: CapturedOptions) {
          super(url, options as CapturedOptions);
          instances.push(this);
        }
      } as unknown as Parameters<typeof createNodePinnedWebSocketFactoryWithConstructor>[1],
    );
    const socket = await factory("wss://social.example/streaming?i=secret-token");
    const messages = streamWebSocketMessages({
      socket,
      networkErrorMessage: "Remote WebSocket connection failed.",
      invalidJsonMessage: "Remote stream returned invalid JSON.",
      errorContext: { origin: "wss://social.example", operation: "stream.connect" },
    });
    const nextMessage = messages.next();

    instances[0]?.fail(new Error("failed URL contains secret-token"));

    const error = await nextMessage.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "NETWORK_ERROR",
      context: { origin: "wss://social.example", operation: "stream.connect" },
    });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("secret-token");
    expect(JSON.stringify(error)).not.toContain("secret-token");
  });
});

interface CapturedOptions {
  readonly autoSelectFamily: false;
  readonly lookup: (
    hostname: string,
    options: unknown,
    callback: (error: Error | null, address: string, family: number) => void,
  ) => void;
  readonly servername: string;
  readonly headers: { readonly host: string };
  readonly closeTimeout: number;
  readonly maxBufferedChunks: number;
  readonly maxFragments: number;
  readonly maxPayload: number;
  readonly perMessageDeflate: boolean;
}

class CapturingWebSocket extends EventTarget {
  public readonly readyState = 0;
  public nodeLikeErrorsConsumed = 0;
  private errorListenerCount = 0;

  public constructor(
    public readonly url: string,
    public readonly options: CapturedOptions,
  ) {
    super();
  }

  public close(): void {}

  public terminate(): void {}

  public override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "error" && callback !== null) this.errorListenerCount += 1;
    super.addEventListener(type, callback, options);
  }

  public override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === "error" && callback !== null) this.errorListenerCount -= 1;
    super.removeEventListener(type, callback, options);
  }

  public open(): void {
    this.dispatchEvent(new Event("open"));
  }

  public fail(error: Error): void {
    const event = new Event("error");
    Object.defineProperty(event, "error", { value: error });
    this.dispatchEvent(event);
  }

  public openThenFailOnNextTick(error: Error): Promise<void> {
    this.open();
    return new Promise((resolve, reject) =>
      process.nextTick(() => {
        try {
          if (this.errorListenerCount === 0) throw error;
          this.nodeLikeErrorsConsumed += 1;
          this.fail(error);
          resolve();
        } catch (cause) {
          reject(cause);
        }
      }),
    );
  }

  public async lookupAddress(): Promise<{ readonly address: string; readonly family: number }> {
    return new Promise((resolve, reject) => {
      this.options.lookup("social.example", {}, (error, address, family) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ address, family });
      });
    });
  }
}

async function closeTcpServer(server: ReturnType<typeof createTcpServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

interface RawWebSocketServer {
  readonly port: number;
  readonly server: ReturnType<typeof createTcpServer>;
  readonly sockets: Set<Socket>;
}

interface RawWebSocketUpgrade {
  readonly response: Buffer;
  readonly socket: Socket;
}

async function createRawWebSocketServer(
  onUpgrade: (upgrade: RawWebSocketUpgrade) => void,
  onClientData?: (data: Buffer) => void,
): Promise<RawWebSocketServer> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let request = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (data: Buffer) => {
      if (upgraded) {
        onClientData?.(data);
        return;
      }
      request = Buffer.concat([request, data]);
      const headerEnd = request.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headers = request.subarray(0, headerEnd).toString("utf8");
      const key = /^sec-websocket-key:\s*(.+)$/im.exec(headers)?.[1]?.trim();
      if (key === undefined) {
        socket.destroy(new Error("Missing Sec-WebSocket-Key header."));
        return;
      }
      upgraded = true;
      onUpgrade({ response: createUpgradeResponse(key), socket });
      const remaining = request.subarray(headerEnd + 4);
      if (remaining.length > 0) onClientData?.(remaining);
      request = Buffer.alloc(0);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the raw WebSocket server to expose a TCP port.");
  }
  return { port: address.port, server, sockets };
}

function createUpgradeResponse(key: string): Buffer {
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  return Buffer.from(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
}

function encodeServerFrame(opcode: number, value = "", final = true): Buffer {
  const payload = Buffer.from(value);
  if (payload.length >= 126) throw new Error("The raw test frame must use a short payload.");
  return Buffer.concat([Buffer.from([(final ? 0x80 : 0) | opcode, payload.length]), payload]);
}

function webSocketTransportErrorCode(event: Event): unknown {
  if (!("error" in event)) return undefined;
  const error = event.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return error.code;
}

async function resolveWithin<T>(promise: Promise<T>, delayMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), delayMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function closeRawWebSocketServer(rawServer: RawWebSocketServer): Promise<void> {
  for (const socket of rawServer.sockets) socket.destroy();
  await closeTcpServer(rawServer.server);
}
