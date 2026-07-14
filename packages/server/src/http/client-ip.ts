import { type Context } from "hono";

export type ClientIpResolver = (request: Request, peerAddress: string | undefined) => string;

/**
 * Resolves the rate-limit identity from an explicitly trusted resolver or the
 * transport peer. Forwarding headers are intentionally not consulted here.
 */
export function resolveClientIp(
  request: Request,
  resolver: ClientIpResolver | undefined,
  peerAddress: string | undefined,
): string | undefined {
  const candidate =
    resolver === undefined ? (peerAddress ?? "unknown") : resolver(request, peerAddress);
  if (typeof candidate !== "string") return undefined;

  const value = candidate.trim();
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  return value === "" || value.length > 256 || hasControlCharacter ? undefined : value;
}

export function peerAddressFor(context: Context): string | undefined {
  const environment: unknown = context.env;
  if (typeof environment !== "object" || environment === null) return undefined;
  const incoming = Reflect.get(environment, "incoming") as unknown;
  if (typeof incoming !== "object" || incoming === null) return undefined;
  const socket = Reflect.get(incoming, "socket") as unknown;
  if (typeof socket !== "object" || socket === null) return undefined;
  const remoteAddress = Reflect.get(socket, "remoteAddress") as unknown;
  return typeof remoteAddress === "string" ? remoteAddress : undefined;
}
