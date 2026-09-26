import { HubConnection, HubConnectionBuilder, HubConnectionState, HttpTransportType, LogLevel } from "@microsoft/signalr";

export interface Quote {
  symbol?: string;
  lastPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  change?: number;
  changePercent?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  lastUpdated?: string;
  timestamp?: string;
  [k: string]: unknown;
}

/**
 * Lazily-connected SignalR market hub client. Subscribes to quotes per
 * contract on first request and keeps a merged latest-quote cache.
 */
/** The subset of a SignalR HubConnection this module uses (lets tests inject a fake). */
export type HubConnectionLike = Pick<HubConnection, "on" | "onreconnected" | "onclose" | "start" | "stop" | "invoke" | "state">;

export function buildSignalRConnection(url: string, getToken: () => Promise<string>): HubConnectionLike {
  return new HubConnectionBuilder()
    .withUrl(url, {
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      accessTokenFactory: () => getToken(),
      timeout: 10000,
    })
    .withAutomaticReconnect()
    // stdout is the MCP stdio channel; never let SignalR log there.
    .configureLogging(LogLevel.None)
    .build();
}

export interface QuoteSource {
  getQuote(contractId: string, timeoutMs?: number): Promise<{ quote: Quote; ageMs: number } | null>;
  close(): Promise<void>;
}

export class MarketHub implements QuoteSource {
  private conn: HubConnectionLike | null = null;
  private starting: Promise<HubConnectionLike> | null = null;
  private readonly quotes = new Map<string, { quote: Quote; receivedAt: number }>();
  private readonly subscribed = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string>,
    private readonly build: (url: string, getToken: () => Promise<string>) => HubConnectionLike = buildSignalRConnection,
  ) {}

  private connect(): Promise<HubConnectionLike> {
    if (this.conn?.state === HubConnectionState.Connected) return Promise.resolve(this.conn);
    this.starting ??= (async () => {
      try {
        const conn = this.build(this.url, this.getToken);
        conn.on("GatewayQuote", (contractId: string, data: Quote) => {
          const prev = this.quotes.get(contractId)?.quote ?? {};
          // Quote pushes can be partial; merge onto the last known state.
          this.quotes.set(contractId, { quote: { ...prev, ...data }, receivedAt: Date.now() });
          for (const w of this.waiters.get(contractId) ?? []) w();
          this.waiters.delete(contractId);
        });
        conn.onreconnected(async () => {
          for (const id of this.subscribed) await conn.invoke("SubscribeContractQuotes", id).catch(() => {});
        });
        conn.onclose(() => {
          this.conn = null;
          this.subscribed.clear();
        });
        await conn.start();
        this.conn = conn;
        return conn;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Latest quote for a contract, waiting up to timeoutMs for the first push. */
  async getQuote(contractId: string, timeoutMs = 5000): Promise<{ quote: Quote; ageMs: number } | null> {
    const conn = await this.connect();
    if (!this.subscribed.has(contractId)) {
      await conn.invoke("SubscribeContractQuotes", contractId);
      this.subscribed.add(contractId);
    }
    if (!this.quotes.has(contractId)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const list = this.waiters.get(contractId) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.waiters.set(contractId, list);
      });
    }
    const hit = this.quotes.get(contractId);
    return hit ? { quote: hit.quote, ageMs: Date.now() - hit.receivedAt } : null;
  }

  async close(): Promise<void> {
    await this.conn?.stop();
  }
}
