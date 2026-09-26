import type { Config } from "./config.js";

/** Every ProjectX REST response carries these fields. */
export interface ApiEnvelope {
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

export class ProjectXError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly errorCode?: number,
    readonly httpStatus?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const LOGIN_ERRORS: Record<number, string> = {
  3: "InvalidCredentials: username/apiKey pair did not match an active key (use your platform username, not email).",
  7: "AgreementsNotSigned: log into the platform and accept the pending agreements.",
  9: "ApiSubscriptionNotFound: no active API subscription on this user.",
  10: "ApiKeyAuthenticationDisabled: your firm has turned off API key login.",
};

// Tokens last 24h; refresh well before that.
const TOKEN_REFRESH_MS = 20 * 60 * 60 * 1000;

type FetchFn = typeof fetch;

/**
 * Thin ProjectX Gateway REST client. Handles login, token refresh, a single
 * retry on 401 (re-login) and 429 (backoff), and envelope error checking.
 */
export class ProjectXClient {
  private token: string | null = null;
  private tokenIssuedAt = 0;
  private loginInFlight: Promise<string> | null = null;

  constructor(
    private readonly config: Config,
    private readonly fetchFn: FetchFn = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Current bearer token, logging in or refreshing as needed. */
  async getToken(): Promise<string> {
    if (this.token && Date.now() - this.tokenIssuedAt < TOKEN_REFRESH_MS) return this.token;
    if (this.token) {
      try {
        const res = await this.raw<ApiEnvelope & { newToken?: string }>("/api/Auth/validate", {}, this.token);
        if (res.success && res.newToken) return this.setToken(res.newToken);
      } catch {
        // fall through to a fresh login
      }
    }
    return this.login();
  }

  private setToken(token: string): string {
    this.token = token;
    this.tokenIssuedAt = Date.now();
    return token;
  }

  private login(): Promise<string> {
    this.loginInFlight ??= (async () => {
      try {
        const res = await this.raw<ApiEnvelope & { token: string | null }>("/api/Auth/loginKey", {
          userName: this.config.username,
          apiKey: this.config.apiKey,
        });
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

  private async raw<T>(path: string, body: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await this.fetchFn(this.config.apiUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProjectXError(`HTTP ${res.status} from ${path}${text ? `: ${text.slice(0, 500)}` : ""}`, path, undefined, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * Authenticated POST. Throws ProjectXError when success is false unless
   * `allowFailure` is set (for endpoints where the caller interprets errorCode).
   */
  async post<T extends ApiEnvelope>(path: string, body: unknown, opts: { allowFailure?: boolean } = {}): Promise<T> {
    let res: T | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.raw<T>(path, body, await this.getToken());
        break;
      } catch (e) {
        if (!(e instanceof ProjectXError) || attempt > 0) throw e;
        if (e.httpStatus === 401) {
          this.token = null;
          continue;
        }
        if (e.httpStatus === 429) {
          await this.sleep(path === "/api/History/retrieveBars" ? 5000 : 2000);
          continue;
        }
        throw e;
      }
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
}
