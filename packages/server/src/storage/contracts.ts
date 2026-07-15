export type SecurityStateExpiryMode = "native" | "sweep";

export interface SecurityStateExpiryMetadata {
  readonly expiryMode?: SecurityStateExpiryMode;
}

export interface BrowserSessionBase {
  readonly id: string;
  readonly csrfTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revision: number;
}

export type BrowserSessionRecord = BrowserSessionBase &
  (
    | { readonly authenticated: false }
    | { readonly authenticated: true; readonly activityPlugSessionId: string }
  );

export interface BrowserSessionAdmissionLimits {
  readonly subject: string;
  readonly maximumLiveSessions: number;
  readonly maximumLiveSessionsPerSubject: number;
  readonly maximumCreationsPerWindow: number;
  readonly windowMilliseconds: number;
}

export type BrowserSessionAdmissionResult =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: "conflict" | "capacity_exceeded" | "subject_capacity_exceeded";
    }
  | {
      readonly admitted: false;
      readonly reason: "rate_limited";
      readonly retryAfterSeconds: number;
    };

export interface BrowserSessionStore extends SecurityStateExpiryMetadata {
  create(record: BrowserSessionRecord): Promise<boolean>;
  admit(
    record: BrowserSessionRecord,
    limits: BrowserSessionAdmissionLimits,
  ): Promise<BrowserSessionAdmissionResult>;
  get(id: string): Promise<BrowserSessionRecord | null>;
  compareAndSet(id: string, revision: number, next: BrowserSessionRecord): Promise<boolean>;
  delete(id: string): Promise<void>;
  deleteExpired(now?: Date, limit?: number): Promise<number>;
}

export interface OAuthStateBinding {
  readonly adapterId: string;
  readonly origin: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifierHash: string;
}

export interface OAuthStateRecord {
  readonly stateHash: string;
  readonly binding: OAuthStateBinding;
  readonly browserSessionId: string;
  readonly clientSecretRef?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revision: number;
}

export interface OAuthStateClaim extends OAuthStateRecord {
  readonly claimToken: string;
  readonly leaseUntil: string;
}

export interface OAuthStateStore extends SecurityStateExpiryMetadata {
  create(record: OAuthStateRecord): Promise<boolean>;
  claim(stateHash: string, leaseUntil: string): Promise<OAuthStateClaim | null>;
  release(claim: OAuthStateClaim): Promise<boolean>;
  consume(claim: OAuthStateClaim): Promise<boolean>;
  deleteExpired(now?: Date, limit?: number): Promise<number>;
}

export interface OAuthClientSecretStore extends SecurityStateExpiryMetadata {
  put(ref: string, secret: string, expiresAt: string): Promise<boolean>;
  take(ref: string): Promise<string | null>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<boolean>;
  deleteExpired(now?: Date, limit?: number): Promise<number>;
}

export interface StreamTicketRecord {
  readonly ticketHash: string;
  readonly browserSessionId: string;
  readonly operation: StreamOperation;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type StreamOperation = "stream.timeline" | "stream.notifications" | "stream.conversations";

export interface StreamTicketStore {
  create(record: StreamTicketRecord): Promise<boolean>;
  take(ticketHash: string): Promise<StreamTicketRecord | null>;
}

export interface OAuthStartLimiterInput {
  readonly clientIp: string;
  readonly origin: string;
  readonly now: Date;
}

export type OAuthStartLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export type OAuthStartReservationResult =
  | { readonly allowed: true; readonly release: () => Promise<void> }
  | {
      readonly allowed: false;
      readonly reason: "rate_limited";
      readonly retryAfterSeconds: number;
    }
  | { readonly allowed: false; readonly reason: "capacity_exceeded" };

export interface OAuthStartLimiter {
  take(input: OAuthStartLimiterInput): Promise<OAuthStartLimitResult>;
  reserve?(input: OAuthStartLimiterInput): Promise<OAuthStartReservationResult>;
}

export interface ShortCacheStore extends SecurityStateExpiryMetadata {
  get(key: string): Promise<Uint8Array | null>;
  take(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array, expiresAt: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteExpired?(now?: Date, limit?: number): Promise<number>;
}
