import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import {
  type StreamOperation,
  type StreamTicketRecord,
  type StreamTicketStore,
} from "../storage/contracts.js";

const streamTicketLifetimeMilliseconds = 60_000;

export interface IssueStreamTicketOptions {
  readonly browserSessionId: string;
  readonly operation: StreamOperation;
  readonly now?: () => Date;
  readonly randomBytes?: () => Uint8Array;
}

export async function issueStreamTicket(
  store: StreamTicketStore,
  options: IssueStreamTicketOptions,
): Promise<string> {
  const now = options.now?.() ?? new Date();
  const random = options.randomBytes?.() ?? nodeRandomBytes(32);
  if (!(random instanceof Uint8Array) || random.byteLength !== 32) {
    throw new TypeError("Stream ticket entropy must contain exactly 32 bytes.");
  }
  const ticket = Buffer.from(random).toString("base64url");
  const record: StreamTicketRecord = {
    ticketHash: hashStreamTicket(ticket),
    browserSessionId: options.browserSessionId,
    operation: options.operation,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + streamTicketLifetimeMilliseconds).toISOString(),
  };
  if (!(await store.create(record))) {
    throw new Error("Unable to create a unique stream ticket.");
  }
  return ticket;
}

export async function consumeStreamTicket(
  store: StreamTicketStore,
  ticket: string,
  now = new Date(),
): Promise<StreamTicketRecord | null> {
  if (typeof ticket !== "string" || ticket.length < 32 || ticket.length > 256) return null;
  const record = await store.take(hashStreamTicket(ticket));
  if (record === null || Date.parse(record.expiresAt) <= now.getTime()) return null;
  return record;
}

function hashStreamTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("base64url");
}
