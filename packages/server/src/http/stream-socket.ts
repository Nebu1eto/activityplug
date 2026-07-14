import { type StreamEvent } from "@activityplug/core";
import { type WebSocketLike } from "@hono/node-server";
import { type WSEvents, type WSContext } from "hono/ws";

import { serializeActivityPlugError } from "../api/errors.js";
import { serializeStreamEvent } from "../api/service.js";
import { type RequestLimits } from "../security/request-limits.js";
import { toActivityPlugError } from "./app-helpers.js";

const OPEN = 1;
const TRY_AGAIN_LATER = 1013;
const SLOW_CONSUMER_REASON = "WebSocket consumer exceeded its queue budget.";

export interface BoundedStreamSocketOptions {
  readonly requestSignal: AbortSignal;
  readonly limits: RequestLimits;
  readonly connect: (signal: AbortSignal) => Promise<AsyncIterable<StreamEvent>>;
}

/**
 * Creates a streaming socket whose producer is aborted when the transport can
 * no longer keep its outbound queue within the configured per-connection
 * budgets.
 */
export function createBoundedStreamSocket(
  options: BoundedStreamSocketOptions,
): WSEvents<WebSocketLike> {
  const limits = options.limits;
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(options.requestSignal.reason);
  if (options.requestSignal.aborted) abortFromRequest();
  else options.requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  let overloaded = false;
  let pendingEvents = 0;
  let pendingBytes = 0;

  const detach = () => options.requestSignal.removeEventListener("abort", abortFromRequest);

  const closeSlowConsumer = (socket: WSContext<WebSocketLike>) => {
    if (overloaded) return;
    overloaded = true;
    controller.abort(new Error(SLOW_CONSUMER_REASON));
    socket.close(TRY_AGAIN_LATER, SLOW_CONSUMER_REASON);
  };

  const writable = (socket: WSContext<WebSocketLike>): boolean =>
    socket.readyState === OPEN &&
    (socket.raw === undefined || socket.raw.readyState === OPEN) &&
    !overloaded;

  const send = (socket: WSContext<WebSocketLike>, data: string): boolean => {
    if (!writable(socket)) return false;
    const byteLength = Buffer.byteLength(data);
    const raw = socket.raw;
    const rawBufferedBytes = websocketBufferedAmount(raw);
    if (
      pendingEvents >= limits.websocketQueuedEvents ||
      byteLength > limits.websocketBufferedBytes - pendingBytes ||
      byteLength > limits.websocketBufferedBytes - rawBufferedBytes
    ) {
      closeSlowConsumer(socket);
      return false;
    }

    pendingEvents += 1;
    pendingBytes += byteLength;
    let completed = false;
    const complete = (error?: Error) => {
      if (completed) return;
      completed = true;
      pendingEvents -= 1;
      pendingBytes -= byteLength;
      if (error !== undefined) closeSlowConsumer(socket);
    };

    try {
      if (raw !== undefined) {
        // The Node adapter exposes a narrower interface than the ws runtime,
        // whose completion callback is required for accurate queue accounting.
        Reflect.apply(raw.send, raw, [data, complete]);
      } else {
        socket.send(data);
        queueMicrotask(complete);
      }
      return true;
    } catch (error) {
      complete(error instanceof Error ? error : new Error("WebSocket send failed."));
      return false;
    }
  };

  return {
    async onOpen(_event, socket) {
      try {
        controller.signal.throwIfAborted();
        for await (const event of await options.connect(controller.signal)) {
          if (
            !send(socket, JSON.stringify({ event: serializeStreamEvent(event) })) ||
            controller.signal.aborted
          ) {
            break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && writable(socket)) {
          send(
            socket,
            JSON.stringify({ error: serializeActivityPlugError(toActivityPlugError(error)) }),
          );
        }
      } finally {
        detach();
        if (!overloaded && socket.readyState === OPEN) socket.close();
      }
    },
    onClose() {
      controller.abort();
      detach();
    },
  };
}

function websocketBufferedAmount(socket: WebSocketLike | undefined): number {
  if (socket === undefined) return 0;
  const bufferedAmount = Reflect.get(socket, "bufferedAmount") as unknown;
  return typeof bufferedAmount === "number" && Number.isFinite(bufferedAmount) ? bufferedAmount : 0;
}
