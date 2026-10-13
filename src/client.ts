import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";

/** Every ProjectX REST response carries these fields. */
export interface ApiEnvelope {
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

/**
 * How a request failed. `timeout` and `network` mean the request may or may not
 * have reached the broker; `deadline` means it was never sent.
 */
export type FailureKind = "timeout" | "network" | "http" | "deadline" | "unknown_outcome";

export class ProjectXError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly errorCode?: number,
    readonly httpStatus?: number,
    readonly body?: unknown,
    readonly kind?: FailureKind,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Order/place may or may not have been accepted; it was not re-sent. */
export class OrderOutcomeUnknownError extends ProjectXError {
  constructor(
    message: string,
    readonly customTag: string,
  ) {
    super(message, PLACE, undefined, undefined, undefined, "unknown_outcome");
  }
}

export interface PostOptions {
  /** Return success=false envelopes instead of throwing (the caller reads errorCode). */
  allowFailure?: boolean;
  /** Per-attempt timeout. Default 10 s (bars 15 s). */
  timeoutMs?: number;
  /** Absolute time (ms since epoch) by which the call must finish, retries included. */
  deadline?: number;
}

const LOGIN_ERRORS: Record<number, string> = {
  3: "InvalidCredentials: username/apiKey pair did not match an active key (use your platform username, not email).",
  7: "AgreementsNotSigned: log into the platform and accept the pending agreements.",
  9: "ApiSubscriptionNotFound: no active API subscription on this user.",
  10: "ApiKeyAuthenticationDisabled: your firm has turned off API key login.",
};

// Tokens last 24h; refresh well before that.
const TOKEN_REFRESH_MS = 20 * 60 * 60 * 1000;

const PLACE = "/api/Order/place";
const BARS = "/api/History/retrieveBars";
/** Writes that must never be re-sent once they may have reached the broker. */
export const NON_IDEMPOTENT_PATHS = new Set([
  PLACE,
  "/api/Order/modify",
  "/api/Order/cancel",
  "/api/Position/closeContract",
  "/api/Position/partialCloseContract",
]);
export const DEFAULT_TIMEOUT_MS = 10_000;
export const BARS_TIMEOUT_MS = 15_000;
/** Backoff before each retry of a read (network error, timeout, 5xx). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 30_000;
/** The customTag lookup searches from a little before the send; matches must be created after it, less this skew. */
const TAG_LOOKUP_WINDOW_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;

interface OrderRow {
  id: number;
  customTag?: string | null;
  creationTimestamp?: string | null;
  status?: number;
  fillVolume?: number | null;
}

type FetchFn = typeof fetch;

/** A unique customTag for an order the caller sent without one. */
export function newCustomTag(): string {
  return `pxm-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const isTransient = (e: ProjectXError) => e.kind === "timeout" || e.kind === "network" || (e.httpStatus ?? 0) >= 500;

/**
 * Thin ProjectX Gateway REST client: login and token refresh, a timeout on
 * every request, retries for reads (never for order writes that may have been
 * processed), Retry-After on 429, one re-login on 401, and envelope checking.
 */
export class ProjectXClient {
  private token: string | null = null;
  private tokenIssuedAt = 0;
  private loginInFlight: Promise<string> | null = null;

  constructor(
    private readonly config: Config,
    private readonly fetchFn: FetchFn = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  /** Current bearer token, logging in or refreshing as needed. */
  async getToken(opts: PostOptions = {}): Promise<string> {
    if (this.token && this.now() - this.tokenIssuedAt < TOKEN_REFRESH_MS) return this.token;
    if (this.token) {
      try {
        const res = await this.raw<ApiEnvelope & { newToken?: string }>("/api/Auth/validate", {}, this.attemptTimeout("/api/Auth/validate", opts), this.token);
        if (res.success && res.newToken) return this.setToken(res.newToken);
      } catch {
        // fall through to a fresh login
      }
    }
    return this.withinDeadline(this.login(opts), "/api/Auth/loginKey", opts);
  }

  /** A login shared with other callers may run longer than this caller's deadline: stop waiting for it at the deadline. */
  private withinDeadline<T>(p: Promise<T>, path: string, opts: PostOptions): Promise<T> {
    if (opts.deadline === undefined) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ProjectXError(`${path}: no time left before the deadline; the request was not sent`, path, undefined, undefined, undefined, "deadline")),
        Math.max(0, opts.deadline! - this.now()),
      );
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }

  private setToken(token: string): string {
    this.token = token;
    this.tokenIssuedAt = this.now();
    return token;
  }

  private login(opts: PostOptions): Promise<string> {
    this.loginInFlight ??= (async () => {
      try {
        const res = await this.raw<ApiEnvelope & { token: string | null }>(
          "/api/Auth/loginKey",
          { userName: this.config.username, apiKey: this.config.apiKey },
          this.attemptTimeout("/api/Auth/loginKey", opts),
        );
        if (!res.success || !res.token) {
          const why = LOGIN_ERRORS[res.errorCode] ?? res.errorMessage ?? "unknown error";
          throw new ProjectXError(`Login failed (errorCode ${res.errorCode}): ${why}`, "/api/Auth/loginKey", res.errorCode);
        }
        return this.setToken(res.token);
      } finally {
        this.loginInFlight = null;
      }
    })();
    return this.loginInFlight;
  }

  /** Timeout for one attempt: the per-call value, cut short by the deadline. Throws (unsent) if no time is left. */
  private attemptTimeout(path: string, opts: PostOptions): number {
    const base = opts.timeoutMs ?? (path === BARS ? BARS_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    if (opts.deadline === undefined) return base;
    const left = opts.deadline - this.now();
    if (left <= 0) throw new ProjectXError(`${path} not sent: no time left before the deadline`, path, undefined, undefined, undefined, "deadline");
    return Math.min(base, left);
  }

  private async raw<T>(path: string, body: unknown, timeoutMs: number, token?: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(this.config.apiUrl + path, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("Retry-After"), this.now()) : undefined;
        throw new ProjectXError(`HTTP ${res.status} from ${path}${text ? `: ${text.slice(0, 500)}` : ""}`, path, undefined, res.status, undefined, "http", retryAfter);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof ProjectXError) throw e;
      if (ctrl.signal.aborted) throw new ProjectXError(`${path} timed out after ${timeoutMs} ms`, path, undefined, undefined, undefined, "timeout");
      throw new ProjectXError(`${path} network error: ${e instanceof Error ? e.message : String(e)}`, path, undefined, undefined, undefined, "network");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Wait before retry number `retries` if it fits before the deadline. */
  private async backoff(e: ProjectXError, retries: number, path: string, opts: PostOptions): Promise<boolean> {
    if (retries >= RETRY_DELAYS_MS.length) return false;
    const fallback = e.httpStatus === 429 && path === BARS ? 5000 : RETRY_DELAYS_MS[retries];
    const delay = e.retryAfterMs ?? fallback;
    if (delay > MAX_RETRY_AFTER_MS) return false;
    if (opts.deadline !== undefined && this.now() + delay >= opts.deadline) return false;
    await this.sleep(delay);
    return true;
  }

  /**
   * Authenticated POST. Throws ProjectXError when success is false unless
   * `allowFailure` is set (for endpoints where the caller interprets errorCode).
   */
  async post<T extends ApiEnvelope>(path: string, body: unknown, opts: PostOptions = {}): Promise<T> {
    const nonIdempotent = NON_IDEMPOTENT_PATHS.has(path);
    if (path === PLACE) {
      const b = (body ?? {}) as Record<string, unknown>;
      body = { ...b, customTag: b.customTag || newCustomTag() };
    }
    let res: T | undefined;
    let relogged = false;
    let firstSentAt: number | undefined;
    for (let retries = 0; ; ) {
      let sent = false;
      try {
        const token = await this.getToken(opts);
        const timeout = this.attemptTimeout(path, opts);
        sent = true;
        firstSentAt ??= this.now();
        res = await this.raw<T>(path, body, timeout, token);
        break;
      } catch (e) {
        if (!(e instanceof ProjectXError)) throw e;
        if (e.httpStatus === 401 && !relogged) {
          relogged = true;
          this.token = null;
          continue;
        }
        // A 429 was not processed, and a request never sent cannot have been: both are safe to retry.
        const retryable = e.httpStatus === 429 || (isTransient(e) && (!nonIdempotent || !sent));
        if (retryable && (await this.backoff(e, retries, path, opts))) {
          retries++;
          continue;
        }
        if (sent && nonIdempotent && isTransient(e)) {
          if (path === PLACE) return (await this.recoverPlace(body as Record<string, unknown>, firstSentAt!, e.message, opts)) as unknown as T;
          throw new ProjectXError(
            `${e.message}. It was not re-sent because the broker may have processed it; check list_open_orders and list_open_positions.`,
            path, undefined, e.httpStatus, undefined, "unknown_outcome",
          );
        }
        throw e;
      }
    }
    if (path === PLACE && res.success && (res as { orderId?: unknown }).orderId == null) {
      return (await this.recoverPlace(body as Record<string, unknown>, firstSentAt!, "Order/place returned success with no orderId", opts)) as unknown as T;
    }
    if (!res.success && !opts.allowFailure) {
      throw new ProjectXError(
        `${path} failed: errorCode ${res.errorCode}${res.errorMessage ? ` – ${res.errorMessage}` : ""}`,
        path,
        res.errorCode,
        200,
        res,
      );
    }
    return res;
  }

  /**
   * After a lost Order/place reply, find the order by its customTag instead of
   * re-sending it. Only an order created after the first send (less a little
   * clock skew) counts; two matches, or none, leave the outcome unknown. A
   * found order keeps its real status: rejected or cancelled without a fill is
   * success=false.
   */
  private async recoverPlace(body: Record<string, unknown>, sentAt: number, why: string, opts: PostOptions): Promise<ApiEnvelope & { orderId: number }> {
    const tag = body.customTag as string;
    let matches: OrderRow[] = [];
    try {
      const found = await this.post<ApiEnvelope & { orders: OrderRow[] }>(
        "/api/Order/search",
        { accountId: body.accountId, startTimestamp: new Date(sentAt - TAG_LOOKUP_WINDOW_MS).toISOString(), endTimestamp: null },
        { timeoutMs: 3000, deadline: opts.deadline },
      );
      matches = found.orders.filter((o) => o.customTag === tag && Date.parse(o.creationTimestamp ?? "") >= sentAt - CLOCK_SKEW_MS);
    } catch {
      // fall through: the outcome stays unknown
    }
    if (matches.length === 1) {
      const o = matches[0];
      const failed = [3, 4, 5].includes(o.status as number) && !((o.fillVolume ?? 0) > 0);
      const statusName = ["none", "open", "filled", "cancelled", "expired", "rejected", "pending"][o.status as number] ?? `unknown(${o.status})`;
      return {
        success: !failed,
        errorCode: failed ? 2 : 0,
        errorMessage: failed ? `The order was found by its customTag after a lost reply, with status ${statusName}.` : null,
        orderId: o.id,
        recoveredByCustomTag: true,
        status: o.status,
      } as ApiEnvelope & { orderId: number };
    }
    throw new OrderOutcomeUnknownError(
      `Unknown outcome; not re-sent (${why}). ${matches.length > 1 ? `${matches.length} orders carry customTag ${tag}, so none can be told apart` : `No order with customTag ${tag} was found`}. ` +
        "Check list_open_orders and list_open_positions before any retry.",
      tag,
    );
  }
}
